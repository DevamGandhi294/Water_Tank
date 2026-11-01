import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api/api_client.dart';
import '../api/models.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

const _days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const _dayLetters = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

String _skipText(String? r) {
  if (r == null) return '';
  if (r.startsWith('level_')) return 'tank already ${r.substring(6)}% full';
  return {'offline': 'tank was offline', 'already_running': 'pump was already on', 'tank_full': 'tank was full', 'sensor_fault': 'sensor fault', 'device_disabled': 'tank disabled'}[r] ?? r;
}

class TimersScreen extends StatefulWidget {
  const TimersScreen({super.key, required this.device});
  final DeviceDetail device;
  @override
  State<TimersScreen> createState() => _TimersScreenState();
}

class _TimersScreenState extends State<TimersScreen> {
  List<TimerItem>? _items;
  String? _error;
  ApiClient get _api => context.read<Session>().api;
  bool get _canEdit => widget.device.canControl;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await _api.get('/devices/${widget.device.id}/timers');
      if (!mounted) return;
      setState(() {
        _items = (r['items'] as List).map((j) => TimerItem.fromJson(Map<String, dynamic>.from(j))).toList();
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = errText(e));
    }
  }

  Future<void> _toggle(TimerItem t, bool v) async {
    try {
      await _api.patch('/devices/${widget.device.id}/timers/${t.id}', {'enabled': v});
      await _load();
    } catch (e) {
      if (mounted) toast(context, errText(e), bad: true);
    }
  }

  Future<void> _edit([TimerItem? t]) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: C.panel,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (_) => _TimerSheet(deviceId: widget.device.id, timer: t, api: _api),
    );
    if (saved == true) _load();
  }

  @override
  Widget build(BuildContext context) {
    final items = _items;
    final next = items?.where((t) => t.enabled && t.nextRunAt != null).map((t) => t.nextRunAt!).fold<DateTime?>(null, (a, b) => a == null || b.isBefore(a) ? b : a);
    final skipped = items?.where((t) => t.lastSkippedAt != null).fold<TimerItem?>(null, (a, b) => a == null || b.lastSkippedAt!.isAfter(a.lastSkippedAt!) ? b : a);
    return Scaffold(
      appBar: AppBar(title: const Text('Timers'), actions: [
        if (_canEdit) IconButton(tooltip: 'Add timer', icon: const Icon(Icons.add), onPressed: (items?.length ?? 0) >= 8 ? null : () => _edit()),
      ]),
      body: items == null
          ? (_error != null ? ErrorRetry(message: _error!, onRetry: _load) : const Center(child: CircularProgressIndicator()))
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), children: [
                if (items.isEmpty)
                  const Padding(
                    padding: EdgeInsets.only(top: 40),
                    child: Muted('No timers yet. A timer switches the pump on and off at fixed times every day you choose. The tank’s auto cutoff still stops it early if it fills first.', center: true, size: 14),
                  ),
                for (final t in items)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Card(
                      clipBehavior: Clip.antiAlias,
                      child: InkWell(
                        onTap: _canEdit ? () => _edit(t) : null,
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Row(children: [
                              Expanded(
                                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                  Text('${t.startTime} → ${t.stopTime}${t.endsNextDay ? ' (+1 day)' : ''}', style: const TextStyle(fontFamily: 'monospace', fontSize: 18, fontWeight: FontWeight.w700)),
                                  Muted([if (t.name != null && t.name!.isNotEmpty) t.name!, if (t.onlyIfBelowPct != null) 'only if below ${t.onlyIfBelowPct}%'].join(' · ')),
                                ]),
                              ),
                              Switch(value: t.enabled, onChanged: _canEdit ? (v) => _toggle(t, v) : null),
                            ]),
                            const SizedBox(height: 10),
                            Row(children: [
                              for (var i = 0; i < 7; i++)
                                Container(
                                  width: 30,
                                  height: 30,
                                  margin: const EdgeInsets.only(right: 6),
                                  alignment: Alignment.center,
                                  decoration: BoxDecoration(shape: BoxShape.circle, color: t.days.contains(_days[i]) ? C.water : C.bg, border: Border.all(color: t.days.contains(_days[i]) ? C.water : C.line)),
                                  child: Text(_dayLetters[i], style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: t.days.contains(_days[i]) ? Colors.white : C.muted)),
                                ),
                            ]),
                          ]),
                        ),
                      ),
                    ),
                  ),
                if (next != null || skipped != null)
                  Muted([
                    if (next != null) 'Next run: ${fmtTime(next)}.',
                    if (skipped != null) 'Last skipped: ${fmtTime(skipped.lastSkippedAt)}, ${_skipText(skipped.lastSkipReason)}.',
                  ].join(' ')),
                if (!_canEdit) const Padding(padding: EdgeInsets.only(top: 12), child: Muted('View only. Ask the owner for control access to change timers.')),
              ]),
            ),
    );
  }
}

class _TimerSheet extends StatefulWidget {
  const _TimerSheet({required this.deviceId, required this.timer, required this.api});
  final String deviceId;
  final TimerItem? timer;
  final ApiClient api;
  @override
  State<_TimerSheet> createState() => _TimerSheetState();
}

class _TimerSheetState extends State<_TimerSheet> {
  late TimeOfDay _start;
  late TimeOfDay _stop;
  late Set<String> _days0;
  int? _below;
  late final TextEditingController _name;
  bool _busy = false;
  String? _error;

  TimeOfDay _parse(String s) => TimeOfDay(hour: int.parse(s.split(':')[0]), minute: int.parse(s.split(':')[1]));
  String _fmt(TimeOfDay t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

  @override
  void initState() {
    super.initState();
    final t = widget.timer;
    _start = t != null ? _parse(t.startTime) : const TimeOfDay(hour: 6, minute: 0);
    _stop = t != null ? _parse(t.stopTime) : const TimeOfDay(hour: 6, minute: 30);
    _days0 = t != null ? t.days.toSet() : _days.toSet();
    _below = t?.onlyIfBelowPct;
    _name = TextEditingController(text: t?.name ?? '');
  }

  Future<void> _save() async {
    if (_fmt(_start) == _fmt(_stop)) return setState(() => _error = 'Start and stop time must be different');
    if (_days0.isEmpty) return setState(() => _error = 'Choose at least one day');
    setState(() {
      _busy = true;
      _error = null;
    });
    final body = {
      'name': _name.text.trim().isEmpty ? null : _name.text.trim(),
      'startTime': _fmt(_start),
      'stopTime': _fmt(_stop),
      'days': _days.where(_days0.contains).toList(),
      'onlyIfBelowPct': _below,
      'enabled': widget.timer?.enabled ?? true,
    };
    try {
      if (widget.timer == null) {
        await widget.api.post('/devices/${widget.deviceId}/timers', body);
      } else {
        await widget.api.patch('/devices/${widget.deviceId}/timers/${widget.timer!.id}', body);
      }
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) setState(() => _error = errText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _delete() async {
    try {
      await widget.api.delete('/devices/${widget.deviceId}/timers/${widget.timer!.id}');
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) setState(() => _error = errText(e));
    }
  }

  Widget _timeBox(String label, TimeOfDay t, void Function(TimeOfDay) set) => Expanded(
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: () async {
            final r = await showTimePicker(context: context, initialTime: t, builder: (c, child) => MediaQuery(data: MediaQuery.of(c).copyWith(alwaysUse24HourFormat: true), child: child!));
            if (r != null) setState(() => set(r));
          },
          child: InputDecorator(decoration: InputDecoration(labelText: label), child: Text(_fmt(t), style: const TextStyle(fontFamily: 'monospace', fontSize: 18, fontWeight: FontWeight.w700))),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final nextDay = _fmt(_stop).compareTo(_fmt(_start)) < 0;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 20, 20, 16 + MediaQuery.of(context).viewInsets.bottom),
      child: SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(widget.timer == null ? 'New timer' : 'Edit timer', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
          const SizedBox(height: 14),
          Row(children: [_timeBox('Pump ON', _start, (v) => _start = v), const SizedBox(width: 12), _timeBox('Pump OFF', _stop, (v) => _stop = v)]),
          if (nextDay) const Padding(padding: EdgeInsets.only(top: 6), child: Muted('The pump turns off the next day.')),
          const SizedBox(height: 14),
          Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
            for (var i = 0; i < 7; i++)
              InkWell(
                customBorder: const CircleBorder(),
                onTap: () => setState(() => _days0.contains(_days[i]) ? _days0.remove(_days[i]) : _days0.add(_days[i])),
                child: Container(
                  width: 38,
                  height: 38,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(shape: BoxShape.circle, color: _days0.contains(_days[i]) ? C.water : C.bg, border: Border.all(color: _days0.contains(_days[i]) ? C.water : C.line)),
                  child: Text(_dayLetters[i], style: TextStyle(fontWeight: FontWeight.w700, color: _days0.contains(_days[i]) ? Colors.white : C.muted)),
                ),
              ),
          ]),
          const SizedBox(height: 14),
          DropdownButtonFormField<int?>(
            initialValue: _below,
            decoration: const InputDecoration(labelText: 'Only start if the tank is below'),
            items: const [
              DropdownMenuItem(value: null, child: Text('Always start')),
              DropdownMenuItem(value: 80, child: Text('80%')),
              DropdownMenuItem(value: 50, child: Text('50%')),
              DropdownMenuItem(value: 30, child: Text('30%')),
            ],
            onChanged: (v) => setState(() => _below = v),
          ),
          const SizedBox(height: 12),
          TextField(controller: _name, decoration: const InputDecoration(labelText: 'Name (optional)', hintText: 'Morning fill')),
          const SizedBox(height: 12),
          if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_error!, style: const TextStyle(color: C.bad))),
          FilledButton(onPressed: _busy ? null : _save, child: const Text('Save timer')),
          if (widget.timer != null) ...[
            const SizedBox(height: 8),
            TextButton(onPressed: _delete, style: TextButton.styleFrom(foregroundColor: C.bad), child: const Text('Delete timer')),
          ],
        ]),
      ),
    );
  }
}
