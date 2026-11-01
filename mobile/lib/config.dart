/// Server address. Override at build time:
///   flutter run --dart-define=API_BASE=http://192.168.1.10:3000
/// (Android emulator: http://10.0.2.2:3000)
const String apiBase = String.fromEnvironment('API_BASE', defaultValue: 'https://watertank.ecobridgers.com');
const String apiPrefix = '/api/v1';
