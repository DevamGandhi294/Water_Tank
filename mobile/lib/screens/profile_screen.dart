import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../config.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final session = context.watch<Session>();
    final u = session.user;
    if (u == null) return const SizedBox.shrink();
    return Scaffold(
      appBar: AppBar(title: const Text('Profile')),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), children: [
        SectionCard(children: [
          Row(children: [
            CircleAvatar(radius: 24, backgroundColor: C.waterSoft, child: Text(u.fullName.isEmpty ? '?' : u.fullName[0].toUpperCase(), style: const TextStyle(color: C.water, fontWeight: FontWeight.w700, fontSize: 18))),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(u.fullName, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                Muted([u.phone ?? '', if (u.email != null) u.email!].where((x) => x.isNotEmpty).join(' · ')),
              ]),
            ),
          ]),
        ]),
        const SizedBox(height: 12),
        Card(
          clipBehavior: Clip.antiAlias,
          child: Column(children: [
            ListRow(title: 'Edit name and email', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const EditProfileScreen()))),
            const Divider(),
            ListRow(title: 'Change password', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const ChangePasswordScreen()))),
            const Divider(),
            ListRow(title: 'Logged-in phones', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const SessionsScreen()))),
            const Divider(),
            ListRow(
              title: 'Log out of all phones',
              onTap: () async {
                final ok = await confirm(context, title: 'Log out everywhere?', body: 'Every phone logged in to this account is logged out, including this one.', action: 'Log out all');
                if (ok) await session.logoutAll();
              },
            ),
          ]),
        ),
        const SizedBox(height: 16),
        OutlinedButton(onPressed: () => session.logout(), child: const Text('Log out')),
        const SizedBox(height: 10),
        OutlinedButton(
          style: OutlinedButton.styleFrom(foregroundColor: C.bad, side: const BorderSide(color: C.badSoft)),
          onPressed: () => _delete(context),
          child: const Text('Delete my account'),
        ),
        const SizedBox(height: 18),
        Muted('Water Tank 1.0 · $apiBase', center: true, size: 11),
      ]),
    );
  }

  Future<void> _delete(BuildContext context) async {
    final session = context.read<Session>();
    final pw = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete your account?'),
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Your tanks are removed from your account and everyone you shared them with loses access. This cannot be undone.'),
          const SizedBox(height: 12),
          if (session.user?.hasPassword ?? true) TextField(controller: pw, obscureText: true, decoration: const InputDecoration(labelText: 'Your password')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(style: FilledButton.styleFrom(backgroundColor: C.bad, minimumSize: const Size(80, 40)), onPressed: () => Navigator.pop(ctx, true), child: const Text('Delete')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await session.deleteAccount(pw.text.isEmpty ? null : pw.text);
    } catch (e) {
      if (context.mounted) toast(context, errText(e), bad: true);
    }
  }
}

class EditProfileScreen extends StatefulWidget {
  const EditProfileScreen({super.key});
  @override
  State<EditProfileScreen> createState() => _EditProfileScreenState();
}

class _EditProfileScreenState extends State<EditProfileScreen> {
  late final TextEditingController _name;
  late final TextEditingController _email;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final u = context.read<Session>().user!;
    _name = TextEditingController(text: u.fullName);
    _email = TextEditingController(text: u.email ?? '');
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final s = context.read<Session>();
      await s.api.patch('/me', {'fullName': _name.text.trim(), 'email': _email.text.trim().isEmpty ? null : _email.text.trim()});
      await s.reloadMe();
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) setState(() => _error = errText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Name and email')),
        body: ListView(padding: const EdgeInsets.all(16), children: [
          TextField(controller: _name, textCapitalization: TextCapitalization.words, decoration: const InputDecoration(labelText: 'Full name')),
          const SizedBox(height: 12),
          TextField(controller: _email, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'Email (optional)')),
          const SizedBox(height: 16),
          if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(_error!, style: const TextStyle(color: C.bad))),
          FilledButton(onPressed: _busy ? null : _save, child: const Text('Save')),
        ]),
      );
}

class ChangePasswordScreen extends StatefulWidget {
  const ChangePasswordScreen({super.key});
  @override
  State<ChangePasswordScreen> createState() => _ChangePasswordScreenState();
}

class _ChangePasswordScreenState extends State<ChangePasswordScreen> {
  final _cur = TextEditingController();
  final _new = TextEditingController();
  final _new2 = TextEditingController();
  bool _busy = false;
  String? _error;

  Future<void> _save() async {
    if (_new.text.length < 8) return setState(() => _error = 'New password must be at least 8 characters');
    if (_new.text != _new2.text) return setState(() => _error = 'The two new passwords are not the same');
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await context.read<Session>().api.post('/me/password', {'currentPassword': _cur.text, 'newPassword': _new.text});
      if (!mounted) return;
      toast(context, 'Password changed');
      Navigator.pop(context);
    } catch (e) {
      if (mounted) setState(() => _error = errText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Change password')),
        body: ListView(padding: const EdgeInsets.all(16), children: [
          TextField(controller: _cur, obscureText: true, decoration: const InputDecoration(labelText: 'Current password')),
          const SizedBox(height: 12),
          TextField(controller: _new, obscureText: true, decoration: const InputDecoration(labelText: 'New password', helperText: 'At least 8 characters')),
          const SizedBox(height: 12),
          TextField(controller: _new2, obscureText: true, decoration: const InputDecoration(labelText: 'New password again')),
          const SizedBox(height: 16),
          if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(_error!, style: const TextStyle(color: C.bad))),
          FilledButton(onPressed: _busy ? null : _save, child: const Text('Change password')),
        ]),
      );
}

class SessionsScreen extends StatefulWidget {
  const SessionsScreen({super.key});
  @override
  State<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends State<SessionsScreen> {
  List<dynamic>? _items;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await context.read<Session>().api.get('/me/sessions');
      if (mounted) setState(() => _items = r['items'] as List);
    } catch (e) {
      if (mounted) setState(() => _error = errText(e));
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Logged-in phones')),
        body: _items == null
            ? (_error != null ? ErrorRetry(message: _error!, onRetry: _load) : const Center(child: CircularProgressIndicator()))
            : ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), children: [
                Card(
                  clipBehavior: Clip.antiAlias,
                  child: Column(children: [
                    for (var i = 0; i < _items!.length; i++) ...[
                      if (i > 0) const Divider(),
                      ListRow(
                        title: '${_items![i]['deviceLabel'] ?? 'Unknown'}${_items![i]['current'] == true ? ' (this phone)' : ''}',
                        subtitle: 'Since ${fmtTime(DateTime.tryParse('${_items![i]['createdAt']}')?.toLocal())}',
                        trailing: _items![i]['current'] == true
                            ? null
                            : TextButton(
                                style: TextButton.styleFrom(foregroundColor: C.bad),
                                onPressed: () async {
                                  await context.read<Session>().api.delete('/me/sessions/${_items![i]['id']}');
                                  _load();
                                },
                                child: const Text('Log out'),
                              ),
                      ),
                    ],
                  ]),
                ),
              ]),
      );
}
