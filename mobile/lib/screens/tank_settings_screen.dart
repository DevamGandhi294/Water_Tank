import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api/api_client.dart';
import '../api/models.dart';
import '../state/live.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

class TankSettingsScreen extends StatefulWidget {
  const TankSettingsScreen({super.key, required this.deviceId});
  final String deviceId;
  @override
  State<TankSettingsScreen> createState() => _TankSettingsScreenState();
}

class _TankSettingsScreenState extends State<TankSettingsScreen> {
  DeviceDetail? _d;
  double _cutDraft = 25;
  bool _saving = false;
  String? _error;
  List<Map<String, dynamic>> _history = [];
  StreamSubscription? _sub;

  ApiClient get _api => context.read<Session>().api;

  @override
  void initState() {
    super.initState();
    _sub = context.read<Live>().on('settings:sync', deviceId: widget.deviceId).listen((_) => _load());
    _load();
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await _api.get('/devices/${widget.deviceId}');
      final h = await _api.get('/devices/${widget.deviceId}/settings/history?limit=5');
      if (!mounted) return;
      final d = DeviceDetail.fromJson(Map<String, dynamic>.from(r));
      setState(() {
        final firstLoad = _d == null;
        _d = d;
        if (firstLoad || !_saving) _cutDraft = d.settings.cutoffCm;
        _history = (h['items'] as List).map((x) => Map<String, dynamic>.from(x)).toList();
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = errText(e));
    }
  }

  Future<void> _patch(Map<String, dynamic> body, {String ok = 'Saved'}) async {
    setState(() => _saving = true);
    try {
      final r = await _api.patch('/devices/${widget.deviceId}/settings', body);
      if (!mounted) return;
      final sync = r['sync'];
      toast(context, sync == 'queued_offline' ? '$ok. The tank is offline; it gets the change when it is back.' : sync == 'sending' ? '$ok. Sending to the tank…' : ok);
      await _load();
    } catch (e) {
      if (mounted) toast(context, errText(e), bad: true);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _editNumber({required String title, required String label, double? value, String? help, required Future<void> Function(double?) onSave, bool allowEmpty = true}) async {
    final c = TextEditingController(text: value == null ? '' : (value % 1 == 0 ? value.toStringAsFixed(0) : value.toString()));
    final r = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: c, autofocus: true, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: InputDecoration(labelText: label, helperText: help, helperMaxLines: 3)),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(style: FilledButton.styleFrom(minimumSize: const Size(80, 40)), onPressed: () => Navigator.pop(ctx, c.text.trim()), child: const Text('Save')),
        ],
      ),
    );
    if (r == null) return;
    if (r.isEmpty && allowEmpty) return onSave(null);
    final v = double.tryParse(r);
    if (v == null) {
      if (mounted) toast(context, 'Enter a number', bad: true);
      return;
    }
    await onSave(v);
  }

  Future<void> _rename(DeviceDetail d) async {
    final name = TextEditingController(text: d.name ?? '');
    final loc = TextEditingController(text: d.location ?? '');
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Name and location'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: name, decoration: const InputDecoration(labelText: 'Tank name')),
          const SizedBox(height: 12),
          TextField(controller: loc, decoration: const InputDecoration(labelText: 'Location')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(style: FilledButton.styleFrom(minimumSize: const Size(80, 40)), onPressed: () => Navigator.pop(ctx, true), child: const Text('Save')),
        ],
      ),
    );
    if (ok != true || name.text.trim().isEmpty) return;
    try {
      await _api.patch('/devices/${d.id}', {'name': name.text.trim(), 'location': loc.text.trim().isEmpty ? null : loc.text.trim()});
      await _load();
    } catch (e) {
      if (mounted) toast(context, errText(e), bad: true);
    }
  }

  Future<void> _remove(DeviceDetail d) async {
    final ok = await confirm(context,
        title: 'Remove ${d.title}?',
        body: 'Everyone you shared it with loses access, and its timers are deleted. To add it again you will need a new code from support.',
        action: 'Remove',
        danger: true);
    if (!ok || !mounted) return;
    try {
      await _api.delete('/devices/${d.id}');
      if (mounted) Navigator.of(context).popUntil((r) => r.isFirst);
    } catch (e) {
      if (mounted) toast(context, errText(e), bad: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    return Scaffold(
      appBar: AppBar(title: const Text('Tank settings')),
      body: d == null
          ? (_error != null ? ErrorRetry(message: _error!, onRetry: _load) : const Center(child: CircularProgressIndicator()))
          : _body(d),
    );
  }

  Widget _body(DeviceDetail d) {
    final s = d.settings;
    final maxCut = (s.tankHeightCm != null ? (s.tankHeightCm! - 1).clamp(26.0, 300.0) : 150.0).toDouble();
    final draft = _cutDraft.clamp(25.0, maxCut).toDouble();
    final low = draft < 25;
    final out = s.tankHeightCm != null && draft >= s.tankHeightCm!;
    final pending = s.version > s.appliedVersion;
    final changed = draft.round() != s.cutoffCm.round();
    return ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), children: [
      SectionCard(children: [
        Row(children: [
          const Expanded(child: Text('Auto cutoff distance', style: TextStyle(fontWeight: FontWeight.w700))),
          pending ? Pill.warn(s.sync == 'queued_offline' ? 'Waiting for tank' : 'Sending to device…') : Pill.ok('Saved on device ✓'),
        ]),
        const SizedBox(height: 6),
        const Muted('The pump turns OFF when water comes this close to the sensor. Minimum 25 cm.'),
        Row(children: [
          Expanded(
            child: Slider(
              value: draft,
              min: 25,
              max: maxCut,
              divisions: (maxCut - 25).round().clamp(1, 1000),
              label: '${draft.round()} cm',
              onChanged: (v) => setState(() => _cutDraft = v),
            ),
          ),
          SizedBox(width: 64, child: Text('${draft.round()} cm', textAlign: TextAlign.right, style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.w700))),
        ]),
        if (low) const Text('Cutoff must be at least 25 cm. The sensor can’t read closer than that.', style: TextStyle(color: C.bad, fontSize: 13)),
        if (out) const Text('Cutoff must be less than the tank height.', style: TextStyle(color: C.bad, fontSize: 13)),
        const SizedBox(height: 8),
        FilledButton(onPressed: _saving || low || out || !changed ? null : () => _patch({'cutoffCm': draft.roundToDouble()}, ok: 'Cutoff saved'), child: Text(_saving ? 'Saving…' : 'Save')),
        const SizedBox(height: 8),
        Muted('Version ${s.version} · ${pending ? 'the tank has not confirmed yet' : 'confirmed by the tank'}'),
      ]),
      const SizedBox(height: 12),
      Card(
        clipBehavior: Clip.antiAlias,
        child: Column(children: [
          ListRow(
            title: 'Tank height',
            subtitle: 'From the sensor to the tank bottom',
            trailing: Text(s.tankHeightCm == null ? 'Not set ›' : '${s.tankHeightCm!.toStringAsFixed(0)} cm ›', style: const TextStyle(fontFamily: 'monospace')),
            onTap: () => _editNumber(
              title: 'Tank height',
              label: 'Height in cm (30–1000)',
              value: s.tankHeightCm,
              help: 'Leave empty to show only cm. It must be more than the cutoff (${s.cutoffCm.toStringAsFixed(0)} cm).',
              onSave: (v) => _patch({'tankHeightCm': v}),
            ),
          ),
          const Divider(),
          ListRow(
            title: 'Capacity',
            trailing: Text(s.capacityLitres == null ? 'Not set ›' : '${s.capacityLitres} L ›', style: const TextStyle(fontFamily: 'monospace')),
            onTap: () => _editNumber(title: 'Capacity', label: 'Litres', value: s.capacityLitres?.toDouble(), onSave: (v) => _patch({'capacityLitres': v?.round()})),
          ),
          const Divider(),
          ListRow(
            title: 'Auto mode',
            subtitle: 'The board refuses pump ON when the sensor is not working',
            trailing: Switch(value: s.autoMode, onChanged: _saving ? null : (v) => _patch({'autoMode': v})),
          ),
          const Divider(),
          ListRow(
            title: 'Max pump run',
            subtitle: 'Switch the pump off after this long',
            trailing: Text(s.maxPumpMinutes == null ? 'No limit ›' : '${s.maxPumpMinutes} min ›', style: const TextStyle(fontFamily: 'monospace')),
            onTap: () => _editNumber(title: 'Max pump run', label: 'Minutes (empty = no limit)', value: s.maxPumpMinutes?.toDouble(), onSave: (v) => _patch({'maxPumpMinutes': v?.round()})),
          ),
          const Divider(),
          ListRow(title: 'Name / location', trailing: Muted('${d.title}${d.location != null ? ' · ${d.location}' : ''} ›'), onTap: () => _rename(d)),
        ]),
      ),
      const SizedBox(height: 12),
      if (_history.isNotEmpty)
        SectionCard(children: [
          const Text('Change history', style: TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          for (final h in _history)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 5),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(_describe(h)),
                Muted('v${h['version']} · ${h['changedBy'] ?? 'support'} · ${fmtTime(DateTime.tryParse('${h['changedAt']}')?.toLocal())}${h['appliedAt'] != null ? ' · saved on tank' : ''}', size: 12),
              ]),
            ),
        ]),
      const SizedBox(height: 16),
      OutlinedButton(
        style: OutlinedButton.styleFrom(foregroundColor: C.bad, side: const BorderSide(color: C.badSoft)),
        onPressed: () => _remove(d),
        child: const Text('Remove tank from my account'),
      ),
    ]);
  }

  String _describe(Map<String, dynamic> h) {
    const names = {'cutoffCm': 'Cutoff', 'tankHeightCm': 'Height', 'capacityLitres': 'Capacity', 'autoMode': 'Auto mode', 'lowLevelPct': 'Low level', 'fullLevelPct': 'Full level', 'maxPumpMinutes': 'Max run'};
    final n = Map<String, dynamic>.from(h['new'] ?? {});
    final o = Map<String, dynamic>.from(h['old'] ?? {});
    return n.keys.map((k) => '${names[k] ?? k}: ${o[k] ?? '–'} → ${n[k] ?? '–'}').join(', ');
  }
}
