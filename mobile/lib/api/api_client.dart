import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config.dart';

class ApiException implements Exception {
  final int status;
  final String code;
  final String message;
  final String? field;
  ApiException(this.status, this.code, this.message, [this.field]);
  @override
  String toString() => message;
}

/// Token storage + refresh is handled by [Session]; this class only talks HTTP.
class ApiClient {
  ApiClient({required this.getAccessToken, required this.refresh, required this.onLoggedOut});

  final String? Function() getAccessToken;
  /// returns true when new tokens were stored
  final Future<bool> Function() refresh;
  final void Function() onLoggedOut;
  final http.Client _http = http.Client();
  Future<bool>? _refreshing;

  Uri _uri(String path) => Uri.parse('$apiBase$apiPrefix$path');

  Future<dynamic> get(String path) => _send('GET', path);
  Future<dynamic> post(String path, [Object? body]) => _send('POST', path, body);
  Future<dynamic> patch(String path, [Object? body]) => _send('PATCH', path, body);
  Future<dynamic> put(String path, [Object? body]) => _send('PUT', path, body);
  Future<dynamic> delete(String path, [Object? body]) => _send('DELETE', path, body);

  Future<dynamic> _send(String method, String path, [Object? body, bool retry = true]) async {
    final req = http.Request(method, _uri(path));
    final token = getAccessToken();
    if (token != null) req.headers['authorization'] = 'Bearer $token';
    if (body != null) {
      req.headers['content-type'] = 'application/json';
      req.body = jsonEncode(body);
    }
    http.Response res;
    try {
      res = await http.Response.fromStream(await _http.send(req).timeout(const Duration(seconds: 20)));
    } on TimeoutException {
      throw ApiException(0, 'TIMEOUT', 'The server did not answer. Check your internet connection.');
    } catch (_) {
      throw ApiException(0, 'NETWORK', 'No connection to the server. Check your internet connection.');
    }
    if (res.statusCode == 204) return null;
    dynamic json;
    try {
      json = res.body.isEmpty ? null : jsonDecode(utf8.decode(res.bodyBytes));
    } catch (_) {
      json = null;
    }
    if (res.statusCode >= 200 && res.statusCode < 300) return json;
    final err = (json is Map && json['error'] is Map) ? json['error'] as Map : {'code': 'HTTP_${res.statusCode}', 'message': 'Something went wrong (${res.statusCode})'};
    final code = '${err['code']}';
    if (res.statusCode == 401 && retry && token != null && (code == 'TOKEN_EXPIRED' || code == 'INVALID_TOKEN')) {
      _refreshing ??= refresh().whenComplete(() => _refreshing = null);
      if (await _refreshing!) return _send(method, path, body, false);
    }
    if ((res.statusCode == 401 && token != null) || code == 'USER_BLOCKED') onLoggedOut();
    throw ApiException(res.statusCode, code, '${err['message']}', err['field'] as String?);
  }

  /// Unauthenticated call (login, register, refresh)
  Future<dynamic> postPublic(String path, Object body) async {
    http.Response res;
    try {
      res = await _http.post(_uri(path), headers: {'content-type': 'application/json'}, body: jsonEncode(body)).timeout(const Duration(seconds: 20));
    } catch (_) {
      throw ApiException(0, 'NETWORK', 'No connection to the server. Check your internet connection.');
    }
    final json = res.body.isEmpty ? null : jsonDecode(utf8.decode(res.bodyBytes));
    if (res.statusCode >= 200 && res.statusCode < 300) return json;
    final err = (json is Map && json['error'] is Map) ? json['error'] as Map : {'code': 'HTTP_${res.statusCode}', 'message': 'Something went wrong'};
    throw ApiException(res.statusCode, '${err['code']}', '${err['message']}', err['field'] as String?);
  }
}
