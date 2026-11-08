import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../api/api_client.dart';
import '../api/models.dart';
import '../theme.dart';

class Pill extends StatelessWidget {
  const Pill(this.text, {super.key, this.color = C.water, this.bg = C.waterSoft});
  final String text;
  final Color color;
  final Color bg;
  factory Pill.ok(String t) => Pill(t, color: C.ok, bg: C.okSoft);
  factory Pill.warn(String t) => Pill(t, color: C.warn, bg: C.warnSoft);
  factory Pill.bad(String t) => Pill(t, color: C.bad, bg: C.badSoft);
  factory Pill.gray(String t) => Pill(t, color: C.muted, bg: const Color(0xFFEEF2F3));
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(99)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Container(width: 7, height: 7, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
          const SizedBox(width: 6),
          Text(text, style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600)),
        ]),
      );
}

Widget statusPill(DeviceState s, {bool disabled = false}) {
  if (disabled) return Pill.gray('Disabled by support');
  if (!s.online) return Pill.gray(s.lastSeenAt == null ? 'Relay offline' : 'Relay offline · seen ${ago(s.lastSeenAt)} ago');
  if (s.status == 'WORK' || s.faulty) return Pill.ok('Relay online');
  if (s.status == 'CONFIG') return Pill.warn('Wi-Fi setup');
  if (s.status == 'OTA') return Pill.warn('Updating');
  return Pill.warn(s.status);
}

/// The sensor (2nd) board is only known through the relay board.
Widget sensorPill(DeviceState s) {
  if (s.online && s.status == 'WORK') return Pill.ok('Sensor online');
  if (s.online && s.status == 'FAULT') return Pill.bad('Sensor offline');
  if (s.online && s.status == 'DOWN') return Pill.bad('Sensor no echo');
  return Pill.gray('Sensor unknown');
}

String ago(DateTime? t) {
  if (t == null) return '';
  final d = DateTime.now().difference(t);
  if (d.inSeconds < 60) return '${d.inSeconds.clamp(0, 59)} s';
  if (d.inMinutes < 60) return '${d.inMinutes} min';
  if (d.inHours < 24) return '${d.inHours} h';
  return '${d.inDays} d';
}

String fmtTime(DateTime? t) {
  if (t == null) return '–';
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final day = DateTime(t.year, t.month, t.day);
  final hm = DateFormat('HH:mm').format(t);
  if (day == today) return 'Today $hm';
  if (day == today.subtract(const Duration(days: 1))) return 'Yesterday $hm';
  return '${DateFormat('d MMM').format(t)} $hm';
}

String fmtDuration(int? s) {
  if (s == null) return '—';
  if (s < 60) return '$s s';
  final m = (s / 60).round();
  if (m < 60) return '$m min';
  return '${m ~/ 60} h ${m % 60} m';
}

String errText(Object e) => e is ApiException ? e.message : 'Something went wrong';

void toast(BuildContext context, String text, {bool bad = false}) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(text), backgroundColor: bad ? C.bad : C.deep));
}

class SectionCard extends StatelessWidget {
  const SectionCard({super.key, required this.children, this.padding = const EdgeInsets.all(16)});
  final List<Widget> children;
  final EdgeInsets padding;
  @override
  Widget build(BuildContext context) => Card(child: Padding(padding: padding, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children)));
}

class ListRow extends StatelessWidget {
  const ListRow({super.key, required this.title, this.subtitle, this.trailing, this.onTap});
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
          child: Row(children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
                if (subtitle != null) Padding(padding: const EdgeInsets.only(top: 2), child: Text(subtitle!, style: const TextStyle(color: C.muted, fontSize: 13))),
              ]),
            ),
            if (trailing != null) trailing!,
            if (onTap != null && trailing == null) const Icon(Icons.chevron_right, color: C.muted),
          ]),
        ),
      );
}

class Muted extends StatelessWidget {
  const Muted(this.text, {super.key, this.size = 13, this.center = false});
  final String text;
  final double size;
  final bool center;
  @override
  Widget build(BuildContext context) => Text(text, textAlign: center ? TextAlign.center : null, style: TextStyle(color: C.muted, fontSize: size));
}

class ErrorRetry extends StatelessWidget {
  const ErrorRetry({super.key, required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.cloud_off, color: C.muted, size: 40),
            const SizedBox(height: 12),
            Muted(message, center: true, size: 14),
            const SizedBox(height: 12),
            OutlinedButton(onPressed: onRetry, child: const Text('Try again')),
          ]),
        ),
      );
}

Future<bool> confirm(BuildContext context, {required String title, required String body, required String action, bool danger = false}) async {
  final r = await showModalBottomSheet<bool>(
    context: context,
    backgroundColor: C.panel,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
    builder: (c) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 12),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(title, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          Muted(body, size: 14),
          const SizedBox(height: 16),
          FilledButton(style: danger ? FilledButton.styleFrom(backgroundColor: C.bad) : null, onPressed: () => Navigator.pop(c, true), child: Text(action)),
          const SizedBox(height: 8),
          OutlinedButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
        ]),
      ),
    ),
  );
  return r == true;
}

/// Phone input help: "98765 43210" -> "+919876543210"
String normalizePhone(String input) {
  var p = input.replaceAll(RegExp(r'[\s\-().]'), '');
  if (RegExp(r'^[6-9]\d{9}$').hasMatch(p)) p = '+91$p';
  return p;
}
