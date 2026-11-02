import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:water_tank/api/models.dart';
import 'package:water_tank/screens/auth_screens.dart';
import 'package:water_tank/screens/claim_screens.dart';
import 'package:water_tank/theme.dart';
import 'package:water_tank/widgets/common.dart';
import 'package:water_tank/widgets/tank_view.dart';

void main() {
  test('QR sticker text is parsed', () {
    final p = parseQr('WT1:WT-2026-00001:K7P2-9XQM');
    expect(p?.serial, 'WT-2026-00001');
    expect(p?.code, 'K7P2-9XQM');
    expect(parseQr('https://example.com'), isNull);
    final p2 = parseQr('WT2:k7p29xqm4htrb2wd');
    expect(p2?.serial, '');
    expect(p2?.code, 'K7P29XQM4HTRB2WD');
    expect(parseQr('WT2:SHORT'), isNull);
    expect(fmtRegDate('2026-11-02T10:00:00Z'), '02 Nov 2026');
  });

  test('phone numbers are normalised', () {
    expect(normalizePhone('98765 43210'), '+919876543210');
    expect(normalizePhone('+91 98765-43210'), '+919876543210');
  });

  test('device detail JSON from the API is parsed', () {
    final d = DeviceDetail.fromJson({
      'id': 'a', 'serial': 'WT-2026-00001', 'name': 'Home Tank', 'location': 'Roof', 'access': 'control', 'isDisabled': false,
      'state': {'online': true, 'status': 'WORK', 'pumpOn': true, 'distanceCm': 62.4, 'levelPct': 71, 'lastSeenAt': '2026-11-01T10:00:00Z'},
      'timezone': 'Asia/Kolkata', 'hwModel': 'WT-ESP8266-HC12',
      'settings': {'cutoffCm': 35, 'tankHeightCm': 180, 'capacityLitres': 1000, 'autoMode': true, 'lowLevelPct': 20, 'fullLevelPct': 95, 'maxPumpMinutes': 60, 'version': 4, 'appliedVersion': 3, 'sync': 'sending'},
      'openPumpRun': {'id': 812, 'startedAt': '2026-11-01T10:00:00Z', 'startSource': 'app', 'startedBy': 'Devv'},
    });
    expect(d.title, 'Home Tank');
    expect(d.canControl, isTrue);
    expect(d.isOwner, isFalse);
    expect(d.state.levelPct, 71);
    expect(d.settings.cutoffCm, 35.0);
    expect(d.settings.version > d.settings.appliedVersion, isTrue);
    expect(d.openPumpRun?.startedBy, 'Devv');
    d.state.merge({'pumpOn': false, 'levelPct': 80});
    expect(d.state.pumpOn, isFalse);
    expect(d.state.levelPct, 80);
  });

  testWidgets('login screen shows phone, password and sign-up link', (tester) async {
    await tester.pumpWidget(MaterialApp(theme: buildTheme(), home: const LoginScreen()));
    expect(find.text('Water Tank'), findsOneWidget);
    expect(find.text('Phone number'), findsOneWidget);
    expect(find.text('Log in'), findsOneWidget);
    expect(find.text('Create an account'), findsOneWidget);
    expect(find.textContaining('Google'), findsNothing);
  });

  testWidgets('tank drawing renders with and without tank height', (tester) async {
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: Column(children: const [
      TankView(levelPct: 71, distanceCm: 62.4, cutoffCm: 35, tankHeightCm: 180),
      TankView(levelPct: null, distanceCm: 80, cutoffCm: 25, tankHeightCm: null),
    ]))));
    await tester.pumpAndSettle();
    expect(find.byType(TankView), findsNWidgets(2));
    expect(find.bySemanticsLabel('Tank 71% full'), findsOneWidget);
  });
}
