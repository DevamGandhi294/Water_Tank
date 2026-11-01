import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;
import '../config.dart';
import 'session.dart';

class LiveEvent {
  final String name;
  final Map<String, dynamic> data;
  LiveEvent(this.name, this.data);
  String? get deviceId => data['deviceId'] as String?;
}

/// Socket.IO connection: live tank state, command results, settings sync, notifications.
class Live extends ChangeNotifier {
  Live(this.session) {
    session.addListener(_onSession);
    _onSession();
  }

  final Session session;
  io.Socket? _socket;
  String? _tokenUsed;
  final Set<String> _subscribed = {};
  final _events = StreamController<LiveEvent>.broadcast();
  bool connected = false;

  Stream<LiveEvent> get events => _events.stream;
  Stream<LiveEvent> on(String name, {String? deviceId}) =>
      events.where((e) => e.name == name && (deviceId == null || e.deviceId == deviceId));

  static const _names = ['device:state', 'device:online', 'command:result', 'settings:sync', 'pump:run', 'device:event', 'notification', 'access:changed', 'invite', 'device:members'];

  void _onSession() {
    if (!session.loggedIn) {
      _disconnect();
    } else if (_socket == null || _tokenUsed != session.accessToken) {
      _connect();
    }
  }

  void _connect() {
    _disconnect();
    final token = session.accessToken;
    if (token == null) return;
    _tokenUsed = token;
    // forceNew: socket_io_client caches one manager per URL, which would keep the old token
    final s = io.io(apiBase, io.OptionBuilder().setTransports(['websocket']).setAuth({'token': token}).disableAutoConnect().enableForceNew().enableReconnection().build());
    s.onConnect((_) {
      connected = true;
      notifyListeners();
      if (_subscribed.isNotEmpty) _emitSubscribe(_subscribed.toList());
    });
    s.onDisconnect((_) {
      connected = false;
      notifyListeners();
    });
    s.on('auth:expired', (_) => _tokenProblem(s));
    s.onConnectError((err) {
      final text = '$err';
      if (text.contains('TOKEN_EXPIRED') || text.contains('INVALID_TOKEN') || text.contains('TOKEN_REVOKED')) _tokenProblem(s);
    });
    for (final n in _names) {
      s.on(n, (data) {
        if (data is Map) _events.add(LiveEvent(n, Map<String, dynamic>.from(data)));
      });
    }
    _socket = s;
    s.connect();
  }

  DateTime? _lastTokenFix;

  /// The server refused our access token: refresh once (shared with HTTP), then reconnect.
  /// At most once every 10 s, so a server problem can never turn into a refresh loop.
  Future<void> _tokenProblem(io.Socket s) async {
    if (!identical(s, _socket)) return;
    s.dispose();
    _socket = null;
    final now = DateTime.now();
    if (_lastTokenFix != null && now.difference(_lastTokenFix!) < const Duration(seconds: 10)) {
      Future.delayed(const Duration(seconds: 10), () {
        if (_socket == null && session.loggedIn) _connect();
      });
      return;
    }
    _lastTokenFix = now;
    // a successful refresh notifies the session, and _onSession connects with the new token
    if (await session.refreshNow() && _socket == null && session.loggedIn) _connect();
  }

  void _disconnect() {
    _socket?.dispose();
    _socket = null;
    _tokenUsed = null;
    connected = false;
  }

  void _emitSubscribe(List<String> ids) {
    _socket?.emit('device:subscribe', {'deviceIds': ids});
  }

  void subscribe(Iterable<String> ids) {
    final add = ids.where((i) => !_subscribed.contains(i)).toList();
    _subscribed.addAll(add);
    if (add.isNotEmpty && connected) _emitSubscribe(add);
  }

  /// re-sends current states (pull to refresh)
  void resubscribe() {
    if (connected && _subscribed.isNotEmpty) _emitSubscribe(_subscribed.toList());
  }

  @override
  void dispose() {
    session.removeListener(_onSession);
    _disconnect();
    _events.close();
    super.dispose();
  }
}
