import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api/models.dart';
import '../state/session.dart';

import '../widgets/common.dart';

const _labels = {
  'tank_full': ('Tank full', '%'),
  'tank_low': ('Tank low', '%'),
  'sensor_fault': ('Sensor fault', ''),
  'device_offline': ('Device offline', 'min'),
  'pump_long_run': ('Pump running long', 'min'),
  'ota_result': ('Firmware update result', ''),
};

class AlertsScreen extends StatefulWidget {
  const AlertsScreen({super.key, required this.deviceId});
  final String deviceId;
  @override
  State<AlertsScreen> createState() => _AlertsScreenState();
}

class _AlertsScreenState extends State<AlertsScreen> {
  List<AlertSetting>? _items;
  String? _error;
  bool _busy = false;
  bool _quiet = false;
  TimeOfDay _qFrom = const TimeOfDay(hour: 22, minute: 0);
  TimeOfDay _qTo = const TimeOfDay(hour: 6, minute: 0);

  String _fmt(TimeOfDay t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
  TimeOfDay _parse(String s) => TimeOfDay(hour: int.parse(s.substring(0, 2)), minute: int.parse(s.substring(3, 5)));

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await context.read<Session>().api.get('/devices/${widget.deviceId}/alerts');
      final items = (r as List).map((j) => AlertSetting.fromJson(Map<String, dynamic>.from(j))).toList();
      final q = items.where((a) => a.quietFrom != null && a.quietTo != null).firstOrNull;
      if (!mounted) return;
      setState(() {
        _items = items;
        _quiet = q != null;
        if (q != null) {
          _qFrom = _parse(q.quietFrom!);
          _qTo = _parse(q.quietTo!);
        }
      });
    } catch (e) {
      if (mounted) setState(() => _error = errText(e));
    }
  }

  String _desc(AlertSetting a) {
    final t = a.threshold;
    return switch (a.type) {
      'tank_full' => 'at ${t ?? 95}%',
      'tank_low' => 'below ${t ?? 20}%',
      'sensor_fault' => 'right away',
      'device_offline' => 'after ${t ?? 30} min',
      'pump_long_run' => 'over ${t ?? 60} min',
      _ => 'success or failure',
    };
  }

  Future<void> _editThreshold(AlertSetting a) async {
    final unit = _labels[a.type]!.$2;
    if (unit.isEmpty) return;
    final c = TextEditingController(text: '${a.threshold ?? ''}');
    final r = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(_labels[a.type]!.$1),
        content: TextField(controller: c, autofocus: true, keyboardType: TextInputType.number, decoration: InputDecoration(labelText: unit == '%' ? 'Level %' : 'Minutes', suffixText: unit)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(style: FilledButton.styleFrom(minimumSize: const Size(80, 40)), onPressed: () => Navigator.pop(ctx, c.text), child: const Text('OK')),
        ],
      ),
    );
    final v = int.tryParse(r ?? '');
    if (v == null) return;
    if (unit == '%' && (v < 0 || v > 100)) return;
    setState(() => a.threshold = v);
  }

  Future<void> _save() async {
    setState(() => _busy = true);
    try {
      final body = _items!.map((a) {
        a.quietFrom = _quiet ? _fmt(_qFrom) : null;
        a.quietTo = _quiet ? _fmt(_qTo) : null;
        return a.toJson();
      }).toList();
      await context.read<Session>().api.put('/devices/${widget.deviceId}/alerts', body);
      if (mounted) {
        toast(context, 'Alerts saved');
        Navigator.pop(context);
      }
    } catch (e) {
      if (mounted) toast(context, errText(e), bad: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final items = _items;
    return Scaffold(
      appBar: AppBar(title: const Text('My alerts')),
      body: items == null
          ? (_error != null ? ErrorRetry(message: _error!, onRetry: _load) : const Center(child: CircularProgressIndicator()))
          : ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), children: [
              const Muted('These are only for you. Everyone with access sets their own.'),
              const SizedBox(height: 10),
              Card(
                clipBehavior: Clip.antiAlias,
                child: Column(children: [
                  for (var i = 0; i < items.length; i++) ...[
                    if (i > 0) const Divider(),
                    ListRow(
                      title: _labels[items[i].type]?.$1 ?? items[i].type,
                      subtitle: _desc(items[i]) + (_labels[items[i].type]!.$2.isNotEmpty ? ' · tap to change' : ''),
                      onTap: _labels[items[i].type]!.$2.isNotEmpty ? () => _editThreshold(items[i]) : null,
                      trailing: Switch(value: items[i].enabled, onChanged: (v) => setState(() => items[i].enabled = v)),
                    ),
                  ],
                ]),
              ),
              const SizedBox(height: 12),
              Card(
                clipBehavior: Clip.antiAlias,
                child: Column(children: [
                  ListRow(title: 'Quiet hours', subtitle: 'No push between these times (still listed in Alerts)', trailing: Switch(value: _quiet, onChanged: (v) => setState(() => _quiet = v))),
                  if (_quiet) ...[
                    const Divider(),
                    Padding(
                      padding: const EdgeInsets.all(12),
                      child: Row(children: [
                        for (final (label, isFrom) in [('From', true), ('To', false)])
                          Expanded(
                            child: Padding(
                              padding: const EdgeInsets.symmetric(horizontal: 4),
                              child: OutlinedButton(
                                onPressed: () async {
                                  final t = await showTimePicker(context: context, initialTime: isFrom ? _qFrom : _qTo);
                                  if (t != null) {
                                    setState(() {
                                      if (isFrom) {
                                        _qFrom = t;
                                      } else {
                                        _qTo = t;
                                      }
                                    });
                                  }
                                },
                                child: Text('$label ${_fmt(isFrom ? _qFrom : _qTo)}'),
                              ),
                            ),
                          ),
                      ]),
                    ),
                  ],
                ]),
              ),
              const SizedBox(height: 16),
              FilledButton(onPressed: _busy ? null : _save, child: const Text('Save')),
            ]),
    );
  }
}
