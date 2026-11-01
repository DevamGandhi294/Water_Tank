import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api/api_client.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

class ShareScreen extends StatefulWidget {
  const ShareScreen({super.key, required this.deviceId});
  final String deviceId;
  @override
  State<ShareScreen> createState() => _ShareScreenState();
}

class _ShareScreenState extends State<ShareScreen> {
  Map<String, dynamic>? _data;
  String? _error;
  ApiClient get _api => context.read<Session>().api;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await _api.get('/devices/${widget.deviceId}/members');
      if (mounted) {
        setState(() {
          _data = Map<String, dynamic>.from(r);
          _error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = errText(e));
    }
  }

  Future<void> _run(Future<dynamic> Function() fn, String ok) async {
    try {
      await fn();
      if (mounted) toast(context, ok);
    } catch (e) {
      if (mounted) toast(context, errText(e), bad: true);
    }
    _load();
  }

  Future<void> _invite() async {
    final phone = TextEditingController(text: '+91 ');
    String perm = 'control';
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: C.panel,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, set) => Padding(
          padding: EdgeInsets.fromLTRB(20, 20, 20, 16 + MediaQuery.of(ctx).viewInsets.bottom),
          child: SafeArea(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              const Text('Invite someone', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
              const SizedBox(height: 14),
              TextField(controller: phone, autofocus: true, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Phone number')),
              const SizedBox(height: 12),
              SegmentedButton<String>(
                segments: const [ButtonSegment(value: 'view', label: Text('View')), ButtonSegment(value: 'control', label: Text('Control'))],
                selected: {perm},
                onSelectionChanged: (s) => set(() => perm = s.first),
              ),
              const SizedBox(height: 8),
              Muted(perm == 'view' ? 'Sees the level and history.' : 'Can also switch the pump and edit timers.'),
              const SizedBox(height: 14),
              FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Send invite')),
            ]),
          ),
        ),
      ),
    );
    if (ok != true) return;
    await _run(() => _api.post('/devices/${widget.deviceId}/invites', {'phone': normalizePhone(phone.text), 'permission': perm}), 'Invite sent. It shows in their app, or after they sign up with this number.');
  }

  @override
  Widget build(BuildContext context) {
    final d = _data;
    return Scaffold(
      appBar: AppBar(title: const Text('Shared with'), actions: [IconButton(tooltip: 'Invite', icon: const Icon(Icons.person_add_alt), onPressed: _invite)]),
      body: d == null
          ? (_error != null ? ErrorRetry(message: _error!, onRetry: _load) : const Center(child: CircularProgressIndicator()))
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), children: [
                Card(
                  clipBehavior: Clip.antiAlias,
                  child: Column(children: [
                    if (d['owner'] != null) ListRow(title: d['owner']['fullName'] ?? '', subtitle: d['owner']['phone'], trailing: const Pill('Owner')),
                    for (final m in (d['members'] as List)) ...[
                      const Divider(),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
                        child: Row(children: [
                          Expanded(
                            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text(m['fullName'] ?? '', style: const TextStyle(fontWeight: FontWeight.w600)),
                              Muted(m['phone'] ?? ''),
                            ]),
                          ),
                          SegmentedButton<String>(
                            style: const ButtonStyle(visualDensity: VisualDensity.compact),
                            showSelectedIcon: false,
                            segments: const [ButtonSegment(value: 'control', label: Text('Control')), ButtonSegment(value: 'view', label: Text('View'))],
                            selected: {m['permission']},
                            onSelectionChanged: (s) => _run(() => _api.patch('/devices/${widget.deviceId}/members/${m['userId']}', {'permission': s.first}), 'Access changed'),
                          ),
                          IconButton(
                            tooltip: 'Remove',
                            icon: const Icon(Icons.close, color: C.bad),
                            onPressed: () async {
                              final ok = await confirm(context, title: 'Remove ${m['fullName']}?', body: 'They stop seeing this tank at once.', action: 'Remove', danger: true);
                              if (ok) _run(() => _api.delete('/devices/${widget.deviceId}/members/${m['userId']}'), 'Removed');
                            },
                          ),
                        ]),
                      ),
                    ],
                    for (final i in (d['invites'] as List)) ...[
                      const Divider(),
                      ListRow(
                        title: i['phone'],
                        subtitle: 'Invite sent (${i['permission']}) · expires ${fmtTime(DateTime.tryParse('${i['expiresAt']}')?.toLocal())}',
                        trailing: TextButton(
                          style: TextButton.styleFrom(foregroundColor: C.bad),
                          onPressed: () => _run(() => _api.delete('/devices/${widget.deviceId}/invites/${i['id']}'), 'Invite cancelled'),
                          child: const Text('Cancel'),
                        ),
                      ),
                    ],
                  ]),
                ),
                const SizedBox(height: 12),
                const Muted('View sees the level and history. Control can also switch the pump and edit timers. Only the owner changes settings and sharing.'),
              ]),
            ),
    );
  }
}
