import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api/models.dart';
import '../state/live.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key, required this.onRead});
  final VoidCallback onRead;
  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  final List<NotificationItem> _items = [];
  String? _cursor;
  String? _error;
  bool _loaded = false;
  StreamSubscription? _sub;

  @override
  void initState() {
    super.initState();
    _load();
    _sub = context.read<Live>().on('notification').listen((e) {
      setState(() => _items.insert(0, NotificationItem.fromJson(Map<String, dynamic>.from(e.data['notification']))));
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  Future<void> _load({bool more = false}) async {
    try {
      final r = await context.read<Session>().api.get('/notifications?limit=30${more && _cursor != null ? '&cursor=$_cursor' : ''}');
      if (!mounted) return;
      setState(() {
        if (!more) _items.clear();
        _items.addAll((r['items'] as List).map((j) => NotificationItem.fromJson(Map<String, dynamic>.from(j))));
        _cursor = r['nextCursor'];
        _loaded = true;
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = errText(e));
    }
  }

  Future<void> _markAll() async {
    try {
      await context.read<Session>().api.post('/notifications/read', {'all': true});
      setState(() {
        for (final n in _items) {
          n.readAt ??= DateTime.now();
        }
      });
      widget.onRead();
    } catch (e) {
      if (mounted) toast(context, errText(e), bad: true);
    }
  }

  Color _color(String type) => switch (type) {
        'sensor_fault' || 'device_offline' => C.bad,
        'tank_low' || 'pump_long_run' => C.warn,
        'tank_full' => C.ok,
        _ => C.water,
      };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Alerts'), actions: [
        TextButton(onPressed: _items.any((n) => n.readAt == null) ? _markAll : null, child: const Text('Mark all read')),
      ]),
      body: !_loaded
          ? (_error != null ? ErrorRetry(message: _error!, onRetry: _load) : const Center(child: CircularProgressIndicator()))
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), children: [
                if (_items.isEmpty) const Padding(padding: EdgeInsets.only(top: 60), child: Muted('No alerts yet. You can choose which alerts you get on each tank.', center: true, size: 14)),
                for (final n in _items)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Container(
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(color: C.panel, borderRadius: BorderRadius.circular(14), border: Border.all(color: n.readAt == null ? C.water : C.line, width: n.readAt == null ? 1.5 : 1)),
                      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Container(margin: const EdgeInsets.only(top: 5, right: 10), width: 9, height: 9, decoration: BoxDecoration(color: _color(n.type), shape: BoxShape.circle)),
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Row(children: [
                              Expanded(child: Text(n.title, style: const TextStyle(fontWeight: FontWeight.w700))),
                              Muted(fmtTime(n.createdAt), size: 12),
                            ]),
                            const SizedBox(height: 3),
                            Muted(n.body),
                          ]),
                        ),
                      ]),
                    ),
                  ),
                if (_cursor != null) TextButton(onPressed: () => _load(more: true), child: const Text('Show older')),
              ]),
            ),
    );
  }
}
