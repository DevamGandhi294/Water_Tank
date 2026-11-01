import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../api/api_client.dart';
import '../api/models.dart';

/// Holds the logged-in user and tokens (in the phone's secure storage).
class Session extends ChangeNotifier {
  static const _storage = FlutterSecureStorage();
  static const _key = 'wt_session_v1';

  String? accessToken;
  String? refreshToken;
  User? user;
  bool ready = false;
  late final ApiClient api = ApiClient(getAccessToken: () => accessToken, refresh: _refresh, onLoggedOut: _expired);

  bool get loggedIn => accessToken != null && user != null;

  Future<void> load() async {
    try {
      final raw = await _storage.read(key: _key);
      if (raw != null) {
        final j = jsonDecode(raw) as Map<String, dynamic>;
        accessToken = j['accessToken'];
        refreshToken = j['refreshToken'];
        user = User.fromJson(Map<String, dynamic>.from(j['user']));
      }
    } catch (_) {
      await _storage.delete(key: _key);
    }
    ready = true;
    notifyListeners();
    if (loggedIn) {
      // refresh profile in the background; a dead session logs out
      try {
        await reloadMe();
      } catch (_) {}
    }
  }

  Future<void> _save() async {
    if (accessToken == null) {
      await _storage.delete(key: _key);
    } else {
      await _storage.write(key: _key, value: jsonEncode({'accessToken': accessToken, 'refreshToken': refreshToken, 'user': user?.toJson()}));
    }
  }

  Future<void> _apply(Map<String, dynamic> r) async {
    accessToken = r['accessToken'];
    refreshToken = r['refreshToken'];
    if (r['user'] != null) user = User.fromJson(Map<String, dynamic>.from(r['user']));
    await _save();
    notifyListeners();
  }

  Future<void> login(String phone, String password) async {
    final r = await api.postPublic('/auth/login', {'phone': phone, 'password': password, 'deviceLabel': _label()});
    await _apply(Map<String, dynamic>.from(r));
  }

  Future<void> register(String fullName, String phone, String password) async {
    final r = Map<String, dynamic>.from(await api.postPublic('/auth/register', {'fullName': fullName, 'phone': phone, 'password': password, 'deviceLabel': _label()}));
    if (r['accessToken'] != null) {
      await _apply(r);
    } else {
      // server has SMS codes switched on: the phone must be verified first
      throw ApiException(200, 'OTP_REQUIRED', 'A code was sent by SMS. This app version does not support SMS codes yet.');
    }
  }

  Future<bool>? _refreshing;

  /// One refresh at a time for the whole app. The server treats a refresh token
  /// that is used twice as stolen and logs out everywhere, so the HTTP client and
  /// the socket must share this.
  Future<bool> _refresh() {
    return _refreshing ??= _doRefresh().whenComplete(() => _refreshing = null);
  }

  Future<bool> _doRefresh() async {
    final token = refreshToken;
    if (token == null) return false;
    try {
      final r = await api.postPublic('/auth/refresh', {'refreshToken': token});
      accessToken = r['accessToken'];
      refreshToken = r['refreshToken'];
      await _save();
      notifyListeners(); // the socket reconnects with the new access token
      return true;
    } on ApiException catch (e) {
      // only a real "no" from the server logs out; no network keeps the session
      if (e.status == 401 || e.status == 403) await _clear();
      return false;
    } catch (_) {
      return false;
    }
  }

  Future<bool> refreshNow() => _refresh();

  Future<void> reloadMe() async {
    final r = await api.get('/me');
    user = User.fromJson(Map<String, dynamic>.from(r));
    await _save();
    notifyListeners();
  }

  void _expired() {
    _clear();
  }

  Future<void> _clear() async {
    accessToken = null;
    refreshToken = null;
    user = null;
    await _save();
    notifyListeners();
  }

  Future<void> logout() async {
    try {
      await api.post('/auth/logout', {'refreshToken': refreshToken});
    } catch (_) {}
    await _clear();
  }

  Future<void> logoutAll() async {
    try {
      await api.post('/auth/logout-all');
    } catch (_) {}
    await _clear();
  }

  Future<void> deleteAccount(String? password) async {
    await api.delete('/me', {'password': password});
    await _clear();
  }

  String _label() {
    if (kIsWeb) return 'Web';
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return 'Android app';
      case TargetPlatform.iOS:
        return 'iPhone app';
      default:
        return 'App';
    }
  }
}
