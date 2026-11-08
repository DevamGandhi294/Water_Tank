import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api/models.dart';
import '../state/live.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/tank_view.dart';
import 'claim_screens.dart';
import 'notifications_screen.dart';
import 'profile_screen.dart';
import 'tank_screen.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});
  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _tab = 0;
  int _unread = 0;
  StreamSubscription? _sub;

  @override
  void initState() {
    super.initState();
    _loadUnread();
    _sub = context.read<Live>().on('notification').listen((_) => setState(() => _unread++));
  }

  Future<void> _loadUnread() async {
    try {
      final r = await context.read<Session>().api.get('/me');
      if (mounted) setState(() => _unread = (r['unreadNotifications'] ?? 0) as int);
    } catch (_) {}
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final pages = [
      TanksScreen(unread: _unread, openAlerts: () => setState(() => _tab = 1)),
      NotificationsScreen(onRead: () => setState(() => _unread = 0)),
      const ProfileScreen(),
    ];
    return Scaffold(
      body: IndexedStack(index: _tab, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: [
          const NavigationDestination(icon: Icon(Icons.water_drop_outlined), selectedIcon: Icon(Icons.water_drop), label: 'Tanks'),
          NavigationDestination(icon: Badge(isLabelVisible: _unread > 0, label: Text('$_unread'), child: const Icon(Icons.notifications_outlined)), label: 'Alerts'),
          const NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: 'Profile'),
        ],
      ),
    );
  }
}

class TanksScreen extends StatefulWidget {
  const TanksScreen({super.key, required this.unread, required this.openAlerts});
  final int unread;
  final VoidCallback openAlerts;
  @override
  State<TanksScreen> createState() => _TanksScreenState();
}

class _TanksScreenState extends State<TanksScreen> {
  List<DeviceCard>? _tanks;
  List<Invite> _invites = [];
  String? _error;
  final List<StreamSubscription> _subs = [];
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _load();
    final live = context.read<Live>();
    _subs.add(live.on('device:state').listen(_onState));
    _subs.add(live.on('device:online').listen((e) => _onState(LiveEvent(e.name, {'deviceId': e.deviceId, 'online': e.data['online']}))));
    _subs.add(live.on('access:changed').listen((_) => _load()));
    _subs.add(live.on('invite').listen((_) => _load()));
    // keep "offline 5 min" texts fresh
    _tick = Timer.periodic(const Duration(seconds: 30), (_) => mounted ? setState(() {}) : null);
  }

  void _onState(LiveEvent e) {
    final t = _tanks?.where((x) => x.id == e.deviceId).firstOrNull;
    if (t == null) return;
    setState(() => t.state.merge(e.data));
  }

  Future<void> _load() async {
    final api = context.read<Session>().api;
    try {
      final r = await api.get('/devices');
      final inv = await api.get('/invites');
      final tanks = (r['items'] as List).map((j) => DeviceCard.fromJson(Map<String, dynamic>.from(j))).toList();
      if (!mounted) return;
      setState(() {
        _tanks = tanks;
        _invites = (inv['items'] as List).map((j) => Invite.fromJson(Map<String, dynamic>.from(j))).toList();
        _error = null;
      });
      context.read<Live>()
        ..subscribe(tanks.map((t) => t.id))
        ..resubscribe();
    } catch (e) {
      if (mounted) setState(() => _error = errText(e));
    }
  }

  Future<void> _answer(Invite i, bool accept) async {
    final api = context.read<Session>().api;
    try {
      await api.post('/invites/${i.id}/${accept ? 'accept' : 'decline'}');
      if (mounted) toast(context, accept ? '${i.deviceName} added' : 'Invite declined');
    } catch (e) {
      if (mounted) toast(context, errText(e), bad: true);
    }
    _load();
  }

  @override
  void dispose() {
    for (final s in _subs) {
      s.cancel();
    }
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('My tanks'), actions: [
        IconButton(
          tooltip: 'Notifications',
          onPressed: widget.openAlerts,
          icon: Badge(isLabelVisible: widget.unread > 0, child: const Icon(Icons.notifications_outlined)),
        ),
        IconButton(
          tooltip: 'Add tank',
          icon: const Icon(Icons.add),
          onPressed: () async {
            final added = await Navigator.push<bool>(context, MaterialPageRoute(builder: (_) => const ClaimScanScreen()));
            if (added == true) _load();
          },
        ),
      ]),
      body: _error != null && _tanks == null
          ? ErrorRetry(message: _error!, onRetry: _load)
          : _tanks == null
              ? const Center(child: CircularProgressIndicator())
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
                    children: [
                      for (final i in _invites) _InviteBanner(invite: i, onAnswer: (a) => _answer(i, a)),
                      if (_tanks!.isEmpty) _EmptyTanks(onAdd: () async {
                        final added = await Navigator.push<bool>(context, MaterialPageRoute(builder: (_) => const ClaimScanScreen()));
                        if (added == true) _load();
                      }),
                      for (final t in _tanks!)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: _TankCard(
                            tank: t,
                            onTap: () async {
                              await Navigator.push(context, MaterialPageRoute(builder: (_) => TankScreen(deviceId: t.id)));
                              _load();
                            },
                          ),
                        ),
                    ],
                  ),
                ),
    );
  }
}

class _TankCard extends StatelessWidget {
  const _TankCard({required this.tank, required this.onTap});
  final DeviceCard tank;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final s = tank.state;
    final role = {'owner': 'Owner', 'control': 'Can control', 'view': 'View only'}[tank.access] ?? tank.access;
    final low = s.levelPct != null && s.levelPct! <= 20 && s.online;
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(children: [
            MiniTank(levelPct: s.online ? s.levelPct : 0),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Expanded(child: Text(tank.title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16), overflow: TextOverflow.ellipsis)),
                  if (low) Pill.warn('Low'),
                ]),
                const SizedBox(height: 6),
                Wrap(spacing: 6, runSpacing: 6, children: [
                  statusPill(s, disabled: tank.isDisabled),
                  if (!tank.isDisabled) sensorPill(s),
                ]),
                const SizedBox(height: 4),
                Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
                  Text(!s.online ? '–' : s.levelPct != null ? '${s.levelPct}' : (s.distanceCm?.toStringAsFixed(1) ?? '–'),
                      style: TextStyle(fontSize: 30, fontWeight: FontWeight.w700, color: s.online ? C.ink : C.muted)),
                  if (s.online && (s.levelPct != null || s.distanceCm != null)) Text(s.levelPct != null ? '%' : ' cm', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                  const SizedBox(width: 8),
                  if (s.online && s.levelPct != null && s.distanceCm != null) Muted('${s.distanceCm!.toStringAsFixed(1)} cm'),
                ]),
                Muted([
                  s.pumpOn ? 'Pump ON' : 'Pump OFF',
                  if (tank.location != null && tank.location!.isNotEmpty) tank.location!,
                  role,
                ].join(' · ')),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

class _InviteBanner extends StatelessWidget {
  const _InviteBanner({required this.invite, required this.onAnswer});
  final Invite invite;
  final void Function(bool) onAnswer;
  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: C.waterSoft, borderRadius: BorderRadius.circular(14), border: Border.all(color: C.water.withValues(alpha: 0.3))),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${invite.ownerName ?? 'Someone'} shared “${invite.deviceName}” with you', style: const TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 2),
          Muted(invite.permission == 'control' ? 'You can view and switch the pump' : 'You can view the level and history'),
          const SizedBox(height: 10),
          Row(children: [
            Expanded(child: FilledButton(onPressed: () => onAnswer(true), child: const Text('Accept'))),
            const SizedBox(width: 10),
            Expanded(child: OutlinedButton(onPressed: () => onAnswer(false), child: const Text('Decline'))),
          ]),
        ]),
      );
}

class _EmptyTanks extends StatelessWidget {
  const _EmptyTanks({required this.onAdd});
  final VoidCallback onAdd;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 60),
        child: Column(children: [
          const Icon(Icons.water_drop_outlined, size: 56, color: C.water2),
          const SizedBox(height: 12),
          const Text('No tanks yet', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          const Muted('Scan the QR sticker on the box or the device to add your tank.', center: true, size: 14),
          const SizedBox(height: 18),
          FilledButton.icon(onPressed: onAdd, icon: const Icon(Icons.qr_code_scanner), label: const Text('Add a tank')),
        ]),
      );
}
