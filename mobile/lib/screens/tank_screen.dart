import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api/api_client.dart';
import '../api/models.dart';
import '../state/live.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/tank_view.dart';
import 'alerts_screen.dart';
import 'history_screen.dart';
import 'share_screen.dart';
import 'tank_settings_screen.dart';
import 'timers_screen.dart';

class TankScreen extends StatefulWidget {
  const TankScreen({super.key, required this.deviceId});
  final String deviceId;
  @override
  State<TankScreen> createState() => _TankScreenState();
}

class _TankScreenState extends State<TankScreen> {
  DeviceDetail? _d;
  String? _error;
  int? _pendingCommand;
  Timer? _pendingTimer;
  // results that arrive on the socket before the HTTP 202 (the ESP can answer that fast)
  final Map<int, LiveEvent> _earlyResults = {};
  int _timers = 0;
  String _firstTimer = '';
  int _pumpTodayS = 0;
  int _members = 0;
  final List<StreamSubscription> _subs = [];
  Timer? _tick;

  ApiClient get _api => context.read<Session>().api;

  @override
  void initState() {
    super.initState();
    final live = context.read<Live>()..subscribe([widget.deviceId]);
    final id = widget.deviceId;
    _subs.addAll([
      live.on('device:state', deviceId: id).listen((e) => setState(() => _d?.state.merge(e.data))),
      live.on('device:online', deviceId: id).listen((e) => setState(() => _d?.state.online = e.data['online'] == true)),
      live.on('command:result', deviceId: id).listen(_onCommand),
      live.on('pump:run', deviceId: id).listen((e) {
        final run = PumpRun.fromJson(Map<String, dynamic>.from(e.data['run']));
        setState(() => _d?.openPumpRun = run.endedAt == null ? run : null);
        _loadExtras();
      }),
      live.on('settings:sync', deviceId: id).listen((_) => _load()),
      live.on('access:changed', deviceId: id).listen((e) {
        if (e.data['access'] == null && mounted) {
          toast(context, 'You no longer have access to this tank', bad: true);
          Navigator.pop(context);
        } else {
          _load();
        }
      }),
    ]);
    _tick = Timer.periodic(const Duration(seconds: 15), (_) => mounted ? setState(() {}) : null);
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await _api.get('/devices/${widget.deviceId}');
      if (!mounted) return;
      setState(() {
        _d = DeviceDetail.fromJson(Map<String, dynamic>.from(r));
        _error = null;
      });
      _loadExtras();
    } catch (e) {
      if (mounted) setState(() => _error = errText(e));
    }
  }

  Future<void> _loadExtras() async {
    try {
      final t = await _api.get('/devices/${widget.deviceId}/timers');
      final s = await _api.get('/devices/${widget.deviceId}/pump-runs/summary?period=day');
      final items = (t['items'] as List).map((j) => TimerItem.fromJson(Map<String, dynamic>.from(j))).toList();
      int members = 0;
      if (_d?.isOwner == true && _d?.access != 'admin') {
        final m = await _api.get('/devices/${widget.deviceId}/members');
        members = (m['members'] as List).length;
      }
      if (!mounted) return;
      setState(() {
        _timers = items.length;
        _firstTimer = items.where((x) => x.enabled).map((x) => x.startTime).take(3).join(', ');
        _pumpTodayS = (s['totalS'] ?? 0) as int;
        _members = members;
      });
    } catch (_) {}
  }

  void _onCommand(LiveEvent e) {
    final cid = e.data['commandId'];
    if (_pendingCommand == null && cid is int) {
      _earlyResults[cid] = e;
      if (_earlyResults.length > 20) _earlyResults.remove(_earlyResults.keys.first);
      return;
    }
    if (cid != _pendingCommand) return;
    _pendingTimer?.cancel();
    final status = e.data['status'];
    setState(() => _pendingCommand = null);
    if (status != 'acked') {
      final err = e.data['error'];
      toast(context, err == 'near' ? 'The tank is already full' : err == 'fault' ? 'The board refused because Auto mode is on. Turn off Auto mode in Tank settings to run the pump without the sensor.' : status == 'expired' ? 'The tank did not answer' : 'The tank refused the command${err != null ? ' ($err)' : ''}', bad: true);
    }
  }

  Future<void> _pump() async {
    final d = _d;
    if (d == null || _pendingCommand != null) return;
    final action = d.state.pumpOn ? 'off' : 'on';
    try {
      final r = await _api.post('/devices/${d.id}/pump', {'action': action});
      final id = r['commandId'] as int;
      setState(() => _pendingCommand = id);
      final early = _earlyResults.remove(id);
      if (early != null) {
        _onCommand(early);
        return;
      }
      // fallback if the socket is down: ask once after 8 s, give up after 35 s
      _pendingTimer?.cancel();
      _pendingTimer = Timer(const Duration(seconds: 8), () async {
        for (var i = 0; i < 6 && _pendingCommand == id && mounted; i++) {
          try {
            final c = await _api.get('/devices/${d.id}/commands/$id');
            if (c['status'] != 'pending' && c['status'] != 'sent') {
              _onCommand(LiveEvent('command:result', {'commandId': id, 'deviceId': d.id, 'status': c['status'], 'error': c['error']}));
              await _load();
              return;
            }
          } catch (_) {}
          await Future.delayed(const Duration(seconds: 5));
        }
        if (_pendingCommand == id && mounted) setState(() => _pendingCommand = null);
      });
    } catch (e) {
      if (mounted) toast(context, errText(e), bad: true);
    }
  }

  @override
  void dispose() {
    for (final s in _subs) {
      s.cancel();
    }
    _pendingTimer?.cancel();
    _tick?.cancel();
    super.dispose();
  }

  Future<void> _open(Widget page) async {
    await Navigator.push(context, MaterialPageRoute(builder: (_) => page));
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    return Scaffold(
      appBar: AppBar(
        title: Text(d?.title ?? ''),
        actions: [
          if (d != null && d.isOwner) IconButton(tooltip: 'Tank settings', icon: const Icon(Icons.settings_outlined), onPressed: () => _open(TankSettingsScreen(deviceId: d.id))),
        ],
      ),
      body: d == null
          ? (_error != null ? ErrorRetry(message: _error!, onRetry: _load) : const Center(child: CircularProgressIndicator()))
          : RefreshIndicator(onRefresh: _load, child: _body(d)),
    );
  }

  Widget _body(DeviceDetail d) {
    final s = d.state;
    final busy = _pendingCommand != null;
    final run = d.openPumpRun;
    String pumpSub;
    if (busy) {
      pumpSub = 'Waiting for the tank…';
    } else if (s.pumpOn && run != null) {
      final mins = run.startedAt == null ? 0 : DateTime.now().difference(run.startedAt!).inMinutes;
      final src = {'app': 'from app', 'timer': 'by timer', 'button': 'by button', 'admin': 'by support', 'auto': 'automatically'}[run.startSource] ?? '';
      pumpSub = 'Running $mins min · started $src${run.startedBy != null ? ' by ${run.startedBy}' : ''}';
    } else if (!s.online) {
      pumpSub = 'Tank is offline';
    } else if (s.faulty) {
      pumpSub = 'Manual only: auto cutoff needs the sensor';
    } else {
      pumpSub = 'Auto cutoff at ${d.settings.cutoffCm.toStringAsFixed(0)} cm';
    }
    final litres = (d.settings.capacityLitres != null && s.levelPct != null) ? ' · about ${(d.settings.capacityLitres! * s.levelPct! / 100).round()} L' : '';
    return ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), children: [
      Row(children: [
        statusPill(s, disabled: d.isDisabled),
        const Spacer(),
        if (s.lastSeenAt != null) Muted('Updated ${ago(s.lastSeenAt)} ago'),
      ]),
      if (s.online && s.faulty)
        Container(
          margin: const EdgeInsets.only(top: 12),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: C.badSoft, borderRadius: BorderRadius.circular(12)),
          child: Text(s.status == 'FAULT' ? 'The sensor board is not in range, so the level is unknown. You can still switch the pump.' : 'The ultrasonic sensor gives no reading. You can still switch the pump.', style: const TextStyle(color: C.bad)),
        ),
      const SizedBox(height: 12),
      Center(child: TankView(levelPct: s.levelPct, distanceCm: s.online ? s.distanceCm : null, cutoffCm: d.settings.cutoffCm, tankHeightCm: d.settings.tankHeightCm)),
      const SizedBox(height: 8),
      Center(
        child: Text(
          s.levelPct != null ? '${s.levelPct}%' : (s.distanceCm != null ? '${s.distanceCm!.toStringAsFixed(1)} cm' : '–'),
          style: const TextStyle(fontSize: 44, fontWeight: FontWeight.w700, height: 1.1),
        ),
      ),
      Center(child: Muted(s.levelPct != null && s.distanceCm != null ? '${s.distanceCm!.toStringAsFixed(1)} cm from sensor$litres' : (d.settings.tankHeightCm == null ? 'Set the tank height in settings to see %' : ''))),
      const SizedBox(height: 16),
      _PumpButton(on: s.pumpOn, busy: busy, enabled: d.canControl && s.online && !d.isDisabled, subtitle: pumpSub, onTap: _pump, viewOnly: !d.canControl),
      const SizedBox(height: 12),
      Row(children: [
        _Stat(d.settings.autoMode ? 'On' : 'Off', 'Auto mode'),
        const SizedBox(width: 10),
        _Stat('$_timers', 'Timers'),
        const SizedBox(width: 10),
        _Stat(fmtDuration(_pumpTodayS), 'Pump today'),
      ]),
      const SizedBox(height: 12),
      Card(
        clipBehavior: Clip.antiAlias,
        child: Column(children: [
          ListRow(title: 'Timers', trailing: Muted(_firstTimer.isEmpty ? 'None ›' : '$_firstTimer ›'), onTap: () => _open(TimersScreen(device: d))),
          const Divider(),
          ListRow(title: 'Pump log and activity', onTap: () => _open(HistoryScreen(deviceId: d.id))),
          if (d.isOwner && d.access != 'admin') ...[
            const Divider(),
            ListRow(title: 'Shared with', trailing: Muted(_members == 0 ? 'Nobody ›' : '$_members ${_members == 1 ? 'person' : 'people'} ›'), onTap: () => _open(ShareScreen(deviceId: d.id))),
          ],
          const Divider(),
          ListRow(title: 'My alerts for this tank', onTap: () => _open(AlertsScreen(deviceId: d.id))),
          if (!d.isOwner) ...[
            const Divider(),
            ListRow(
              title: 'Leave this tank',
              trailing: const Icon(Icons.logout, color: C.bad, size: 20),
              onTap: () async {
                final ok = await confirm(context, title: 'Leave ${d.title}?', body: 'You will stop seeing this tank. The owner can invite you again.', action: 'Leave', danger: true);
                if (!ok || !mounted) return;
                try {
                  await _api.delete('/devices/${d.id}/me');
                  if (mounted) Navigator.pop(context);
                } catch (e) {
                  if (mounted) toast(context, errText(e), bad: true);
                }
              },
            ),
          ],
        ]),
      ),
    ]);
  }
}

class _PumpButton extends StatelessWidget {
  const _PumpButton({required this.on, required this.busy, required this.enabled, required this.subtitle, required this.onTap, required this.viewOnly});
  final bool on;
  final bool busy;
  final bool enabled;
  final bool viewOnly;
  final String subtitle;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final bg = on ? C.okSoft : C.panel;
    return Semantics(
      button: true,
      label: 'Pump ${on ? 'on' : 'off'}. ${viewOnly ? 'View only' : 'Tap to switch ${on ? 'off' : 'on'}'}',
      child: Material(
        color: bg,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: BorderSide(color: on ? C.ok : C.line, width: on ? 1.5 : 1)),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: enabled && !busy ? onTap : null,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Pump ${busy ? '…' : on ? 'ON' : 'OFF'}', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: on ? C.ok : C.ink)),
                  const SizedBox(height: 2),
                  Muted(viewOnly ? 'View only. Ask the owner for control access.' : subtitle),
                ]),
              ),
              busy
                  ? const SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 3))
                  : Switch(value: on, onChanged: enabled ? (_) => onTap() : null),
            ]),
          ),
        ),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat(this.value, this.label);
  final String value;
  final String label;
  @override
  Widget build(BuildContext context) => Expanded(
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 10),
          decoration: BoxDecoration(color: C.panel, borderRadius: BorderRadius.circular(12), border: Border.all(color: C.line)),
          child: Column(children: [
            Text(value, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
            const SizedBox(height: 2),
            Muted(label, size: 12),
          ]),
        ),
      );
}
