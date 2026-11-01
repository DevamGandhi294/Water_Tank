import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../api/api_client.dart';
import '../api/models.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

const _sourceText = {'app': 'App', 'timer': 'Timer', 'button': 'Button on device', 'admin': 'Support', 'auto': 'Automatic', 'system': 'System'};
const _stopText = {
  'app': 'App', 'timer': 'Timer', 'button': 'Button', 'auto_cutoff': 'Auto cutoff', 'admin': 'Support', 'fault': 'Sensor fault',
  'power_loss': 'Power cut', 'ota': 'Update', 'max_runtime': 'Max run time', 'unknown': 'Unknown',
};

class HistoryScreen extends StatefulWidget {
  const HistoryScreen({super.key, required this.deviceId});
  final String deviceId;
  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  int _tab = 0;
  String _period = 'week';
  Map<String, dynamic>? _summary;
  final List<PumpRun> _runs = [];
  String? _runsCursor;
  final List<DeviceEventItem> _events = [];
  String? _eventsCursor;
  bool _loading = false;
  String? _error;
  ApiClient get _api => context.read<Session>().api;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    _runs.clear();
    _events.clear();
    _runsCursor = null;
    _eventsCursor = null;
    await Future.wait([_loadSummary(), _loadRuns(), _loadEvents()]);
  }

  Future<void> _loadSummary() async {
    try {
      final r = await _api.get('/devices/${widget.deviceId}/pump-runs/summary?period=$_period');
      if (mounted) setState(() => _summary = Map<String, dynamic>.from(r));
    } catch (e) {
      if (mounted) setState(() => _error = errText(e));
    }
  }

  Future<void> _loadRuns({bool more = false}) async {
    if (_loading) return;
    _loading = true;
    try {
      final r = await _api.get('/devices/${widget.deviceId}/pump-runs?limit=30${more && _runsCursor != null ? '&cursor=$_runsCursor' : ''}');
      if (!mounted) return;
      setState(() {
        _runs.addAll((r['items'] as List).map((j) => PumpRun.fromJson(Map<String, dynamic>.from(j))));
        _runsCursor = r['nextCursor'];
      });
    } catch (e) {
      if (mounted) setState(() => _error = errText(e));
    } finally {
      _loading = false;
    }
  }

  Future<void> _loadEvents({bool more = false}) async {
    try {
      final r = await _api.get('/devices/${widget.deviceId}/events?limit=40${more && _eventsCursor != null ? '&cursor=$_eventsCursor' : ''}');
      if (!mounted) return;
      setState(() {
        _events.addAll((r['items'] as List).map((j) => DeviceEventItem.fromJson(Map<String, dynamic>.from(j))));
        _eventsCursor = r['nextCursor'];
      });
    } catch (e) {
      if (mounted) setState(() => _error = errText(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('History')),
      body: RefreshIndicator(
        onRefresh: _reload,
        child: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), children: [
          SegmentedButton<int>(
            segments: const [ButtonSegment(value: 0, label: Text('Pump log')), ButtonSegment(value: 1, label: Text('Activity'))],
            selected: {_tab},
            showSelectedIcon: false,
            onSelectionChanged: (s) => setState(() => _tab = s.first),
          ),
          const SizedBox(height: 12),
          if (_error != null && _runs.isEmpty && _events.isEmpty) ErrorRetry(message: _error!, onRetry: _reload),
          if (_tab == 0) ..._runsTab() else ..._eventsTab(),
        ]),
      ),
    );
  }

  List<Widget> _runsTab() => [
        if (_summary != null) _Chart(summary: _summary!, period: _period, onPeriod: (p) {
          setState(() => _period = p);
          _loadSummary();
        }),
        const SizedBox(height: 12),
        if (_runs.isEmpty) const Padding(padding: EdgeInsets.only(top: 20), child: Muted('The pump has not run yet.', center: true)),
        if (_runs.isNotEmpty)
          Card(
            clipBehavior: Clip.antiAlias,
            child: Column(children: [
              for (var i = 0; i < _runs.length; i++) ...[
                if (i > 0) const Divider(),
                _RunRow(run: _runs[i]),
              ],
            ]),
          ),
        if (_runsCursor != null) TextButton(onPressed: () => _loadRuns(more: true), child: const Text('Show older')),
      ];

  List<Widget> _eventsTab() => [
        if (_events.isEmpty) const Padding(padding: EdgeInsets.only(top: 20), child: Muted('Nothing yet.', center: true)),
        if (_events.isNotEmpty)
          Card(
            clipBehavior: Clip.antiAlias,
            child: Column(children: [
              for (var i = 0; i < _events.length; i++) ...[
                if (i > 0) const Divider(),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Container(
                      margin: const EdgeInsets.only(top: 5, right: 12),
                      width: 9,
                      height: 9,
                      decoration: BoxDecoration(shape: BoxShape.circle, color: _events[i].severity == 'critical' ? C.bad : _events[i].severity == 'warning' ? C.warn : C.water),
                    ),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(_events[i].message ?? _events[i].type, style: const TextStyle(fontWeight: FontWeight.w600)),
                        Muted('${fmtTime(_events[i].occurredAt)}${_events[i].resolvedAt != null && _events[i].severity != 'info' && _events[i].resolvedAt != _events[i].occurredAt ? ' · cleared ${DateFormat('HH:mm').format(_events[i].resolvedAt!)}' : ''}'),
                      ]),
                    ),
                  ]),
                ),
              ],
            ]),
          ),
        if (_eventsCursor != null) TextButton(onPressed: () => _loadEvents(more: true), child: const Text('Show older')),
      ];
}

class _RunRow extends StatelessWidget {
  const _RunRow({required this.run});
  final PumpRun run;
  @override
  Widget build(BuildContext context) {
    final started = run.startSource == 'timer' && run.timerName != null ? 'Timer “${run.timerName}”' : '${_sourceText[run.startSource] ?? run.startSource}${run.startedBy != null ? ' · ${run.startedBy}' : ''}';
    final stopped = run.endedAt == null ? 'still running' : '${_stopText[run.stopReason] ?? run.stopReason ?? '?'}${run.stoppedBy != null ? ' · ${run.stoppedBy}' : ''}';
    final level = run.startLevelPct != null && run.endLevelPct != null ? ' · ${run.startLevelPct} → ${run.endLevelPct}%' : '';
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(fmtTime(run.startedAt), style: const TextStyle(fontWeight: FontWeight.w600))),
          run.endedAt == null ? Pill.ok('Running') : Text(fmtDuration(run.durationS), style: const TextStyle(fontFamily: 'monospace')),
        ]),
        const SizedBox(height: 2),
        Muted('Started: $started · Stopped: $stopped$level'),
      ]),
    );
  }
}

class _Chart extends StatelessWidget {
  const _Chart({required this.summary, required this.period, required this.onPeriod});
  final Map<String, dynamic> summary;
  final String period;
  final void Function(String) onPeriod;
  @override
  Widget build(BuildContext context) {
    final buckets = (summary['buckets'] as List).map((b) => Map<String, dynamic>.from(b)).toList();
    final maxS = buckets.fold<int>(0, (a, b) => (b['totalS'] as int) > a ? b['totalS'] as int : a);
    String label(String date) {
      if (period == 'day') return date.length >= 13 ? date.substring(11, 13) : date;
      final d = DateTime.tryParse(date);
      if (d == null) return date;
      return period == 'week' ? DateFormat('E').format(d) : DateFormat('d').format(d);
    }
    final showEvery = period == 'month' ? 5 : period == 'day' ? 4 : 1;
    return SectionCard(children: [
      Row(children: [
        Expanded(child: Text({'day': 'Run time, today', 'week': 'Run time, last 7 days', 'month': 'Run time, last 30 days'}[period]!, style: const TextStyle(fontWeight: FontWeight.w700))),
        Muted(fmtDuration(summary['totalS'] as int?)),
      ]),
      const SizedBox(height: 10),
      SegmentedButton<String>(
        style: const ButtonStyle(visualDensity: VisualDensity.compact),
        showSelectedIcon: false,
        segments: const [ButtonSegment(value: 'day', label: Text('Day')), ButtonSegment(value: 'week', label: Text('Week')), ButtonSegment(value: 'month', label: Text('Month'))],
        selected: {period},
        onSelectionChanged: (s) => onPeriod(s.first),
      ),
      const SizedBox(height: 14),
      SizedBox(
        height: 130,
        child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          for (var i = 0; i < buckets.length; i++)
            Expanded(
              child: Tooltip(
                message: '${label(buckets[i]['date'])}: ${fmtDuration(buckets[i]['totalS'] as int)}',
                child: Column(mainAxisAlignment: MainAxisAlignment.end, children: [
                  Container(
                    height: maxS == 0 ? 2 : 2 + 100 * (buckets[i]['totalS'] as int) / maxS,
                    margin: EdgeInsets.symmetric(horizontal: period == 'week' ? 6 : 1),
                    decoration: BoxDecoration(color: C.water, borderRadius: const BorderRadius.vertical(top: Radius.circular(4))),
                  ),
                  const SizedBox(height: 6),
                  SizedBox(height: 14, child: Text(i % showEvery == 0 ? label(buckets[i]['date']) : '', style: const TextStyle(fontSize: 10, color: C.muted), overflow: TextOverflow.visible, softWrap: false)),
                ]),
              ),
            ),
        ]),
      ),
    ]);
  }
}
