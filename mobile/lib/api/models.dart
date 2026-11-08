// JSON -> Dart for the shapes in docs/API.md.
DateTime? _dt(dynamic v) => v == null ? null : DateTime.tryParse('$v')?.toLocal();
double? _d(dynamic v) => v == null ? null : (v as num).toDouble();
int? _i(dynamic v) => v == null ? null : (v as num).toInt();

class User {
  final String id;
  final String fullName;
  final String? phone;
  final String? email;
  final String role;
  final bool hasPassword;
  User.fromJson(Map<String, dynamic> j)
      : id = j['id'],
        fullName = j['fullName'] ?? '',
        phone = j['phone'],
        email = j['email'],
        role = j['role'] ?? 'user',
        hasPassword = j['hasPassword'] ?? true;
  Map<String, dynamic> toJson() => {'id': id, 'fullName': fullName, 'phone': phone, 'email': email, 'role': role, 'hasPassword': hasPassword};
}

class DeviceState {
  static const offlineAfter = Duration(seconds: 12);

  bool _online;
  DateTime? _heardAt; // phone clock, so a wrong phone time can't fake Offline
  int _heartbeats = 0; // servers without the live signal never send unchanged reports
  String status;
  bool pumpOn;
  double? distanceCm;
  int? levelPct;
  DateTime? lastSeenAt;
  int? wifiRssi;
  String? fwVersion;
  DeviceState.fromJson(Map<String, dynamic> j)
      : _online = j['online'] ?? false,
        status = j['status'] ?? 'UNKNOWN',
        pumpOn = j['pumpOn'] ?? false,
        distanceCm = _d(j['distanceCm']),
        levelPct = _i(j['levelPct']),
        lastSeenAt = _dt(j['lastSeenAt']),
        wifiRssi = _i(j['wifiRssi']),
        fwVersion = j['fwVersion'];
  bool get online {
    if (!_online) return false;
    if (_heartbeats < 2 || _heardAt == null) return true;
    return DateTime.now().difference(_heardAt!) < offlineAfter;
  }

  set online(bool v) {
    _online = v;
    if (v) _heardAt = DateTime.now();
  }

  void merge(Map<String, dynamic> j) {
    final seen = _dt(j['lastSeenAt']);
    if (seen != null && lastSeenAt != null && seen.isAfter(lastSeenAt!) && j['online'] == _online && j['status'] == status &&
        j['pumpOn'] == pumpOn && _d(j['distanceCm']) == distanceCm && _i(j['levelPct']) == levelPct) {
      _heartbeats++;
    }
    if (j.containsKey('online')) online = j['online'] ?? false;
    if (j.containsKey('status')) status = j['status'] ?? status;
    if (j.containsKey('pumpOn')) pumpOn = j['pumpOn'] ?? false;
    if (j.containsKey('distanceCm')) distanceCm = _d(j['distanceCm']);
    if (j.containsKey('levelPct')) levelPct = _i(j['levelPct']);
    if (j.containsKey('lastSeenAt')) lastSeenAt = _dt(j['lastSeenAt']) ?? lastSeenAt;
  }
  bool get faulty => status == 'FAULT' || status == 'DOWN';
}

class DeviceCard {
  final String id;
  final String serial;
  String? name;
  String? location;
  final String access; // owner | control | view
  final bool isDisabled;
  final DeviceState state;
  DeviceCard.fromJson(Map<String, dynamic> j)
      : id = j['id'],
        serial = j['serial'],
        name = j['name'],
        location = j['location'],
        access = j['access'] ?? 'view',
        isDisabled = j['isDisabled'] ?? false,
        state = DeviceState.fromJson(Map<String, dynamic>.from(j['state'] ?? {}));
  String get title => (name == null || name!.isEmpty) ? serial : name!;
  bool get canControl => access == 'owner' || access == 'control' || access == 'admin';
  bool get isOwner => access == 'owner' || access == 'admin';
}

class Settings {
  final double cutoffCm;
  final double? tankHeightCm;
  final int? capacityLitres;
  final bool autoMode;
  final int lowLevelPct;
  final int fullLevelPct;
  final int? maxPumpMinutes;
  final int version;
  final int appliedVersion;
  final String sync; // applied | sending | queued_offline
  Settings.fromJson(Map<String, dynamic> j)
      : cutoffCm = _d(j['cutoffCm']) ?? 25,
        tankHeightCm = _d(j['tankHeightCm']),
        capacityLitres = _i(j['capacityLitres']),
        autoMode = j['autoMode'] ?? true,
        lowLevelPct = _i(j['lowLevelPct']) ?? 20,
        fullLevelPct = _i(j['fullLevelPct']) ?? 95,
        maxPumpMinutes = _i(j['maxPumpMinutes']),
        version = _i(j['version']) ?? 1,
        appliedVersion = _i(j['appliedVersion']) ?? 0,
        sync = j['sync'] ?? 'applied';
}

class PumpRun {
  final int id;
  final DateTime? startedAt;
  final DateTime? endedAt;
  final int? durationS;
  final String startSource;
  final String? startedBy;
  final String? stopReason;
  final String? stoppedBy;
  final int? startLevelPct;
  final int? endLevelPct;
  final String? timerName;
  PumpRun.fromJson(Map<String, dynamic> j)
      : id = _i(j['id'])!,
        startedAt = _dt(j['startedAt']),
        endedAt = _dt(j['endedAt']),
        durationS = _i(j['durationS']),
        startSource = j['startSource'] ?? 'app',
        startedBy = j['startedBy'],
        stopReason = j['stopReason'],
        stoppedBy = j['stoppedBy'],
        startLevelPct = _i(j['startLevelPct']),
        endLevelPct = _i(j['endLevelPct']),
        timerName = j['timerName'];
}

class DeviceDetail extends DeviceCard {
  final String timezone;
  final String hwModel;
  Settings settings;
  PumpRun? openPumpRun;
  // ignore: use_super_parameters
  DeviceDetail.fromJson(Map<String, dynamic> j)
      : timezone = j['timezone'] ?? 'Asia/Kolkata',
        hwModel = j['hwModel'] ?? '',
        settings = Settings.fromJson(Map<String, dynamic>.from(j['settings'] ?? {})),
        openPumpRun = j['openPumpRun'] == null ? null : PumpRun.fromJson(Map<String, dynamic>.from(j['openPumpRun'])),
        super.fromJson(j);
}

class TimerItem {
  final int id;
  final String? name;
  final String startTime;
  final String stopTime;
  final List<String> days;
  final int? onlyIfBelowPct;
  final bool enabled;
  final bool endsNextDay;
  final DateTime? nextRunAt;
  final DateTime? lastSkippedAt;
  final String? lastSkipReason;
  TimerItem.fromJson(Map<String, dynamic> j)
      : id = _i(j['id'])!,
        name = j['name'],
        startTime = j['startTime'],
        stopTime = j['stopTime'],
        days = List<String>.from(j['days'] ?? const []),
        onlyIfBelowPct = _i(j['onlyIfBelowPct']),
        enabled = j['enabled'] ?? true,
        endsNextDay = j['endsNextDay'] ?? false,
        nextRunAt = _dt(j['nextRunAt']),
        lastSkippedAt = _dt(j['lastSkippedAt']),
        lastSkipReason = j['lastSkipReason'];
}

class DeviceEventItem {
  final int id;
  final String type;
  final String severity;
  final String? message;
  final DateTime? occurredAt;
  final DateTime? resolvedAt;
  DeviceEventItem.fromJson(Map<String, dynamic> j)
      : id = _i(j['id'])!,
        type = j['type'],
        severity = j['severity'] ?? 'info',
        message = j['message'],
        occurredAt = _dt(j['occurredAt']),
        resolvedAt = _dt(j['resolvedAt']);
}

class NotificationItem {
  final int id;
  final String? deviceId;
  final String? deviceName;
  final String type;
  final String title;
  final String body;
  final DateTime? createdAt;
  DateTime? readAt;
  NotificationItem.fromJson(Map<String, dynamic> j)
      : id = _i(j['id'])!,
        deviceId = j['deviceId'],
        deviceName = j['deviceName'],
        type = j['type'],
        title = j['title'] ?? '',
        body = j['body'] ?? '',
        createdAt = _dt(j['createdAt']),
        readAt = _dt(j['readAt']);
}

class Invite {
  final String id;
  final String deviceName;
  final String? ownerName;
  final String permission;
  Invite.fromJson(Map<String, dynamic> j)
      : id = j['id'],
        deviceName = j['deviceName'] ?? '',
        ownerName = j['ownerName'],
        permission = j['permission'] ?? 'view';
}

class AlertSetting {
  final String type;
  bool enabled;
  int? threshold;
  String? quietFrom;
  String? quietTo;
  AlertSetting.fromJson(Map<String, dynamic> j)
      : type = j['type'],
        enabled = j['enabled'] ?? true,
        threshold = _i(j['threshold']),
        quietFrom = j['quietFrom'],
        quietTo = j['quietTo'];
  Map<String, dynamic> toJson() => {'type': type, 'enabled': enabled, 'threshold': threshold, 'quietFrom': quietFrom, 'quietTo': quietTo};
}
