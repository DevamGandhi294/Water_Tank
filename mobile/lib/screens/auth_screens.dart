import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _phone = TextEditingController(text: '+91 ');
  final _pw = TextEditingController();
  bool _busy = false;
  bool _hide = true;
  String? _error;

  Future<void> _login() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await context.read<Session>().login(normalizePhone(_phone.text), _pw.text);
    } catch (e) {
      if (mounted) setState(() => _error = errText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(22, 48, 22, 22),
          children: [
            const Icon(Icons.water_drop_outlined, size: 52, color: C.water),
            const SizedBox(height: 10),
            const Text('Water Tank', textAlign: TextAlign.center, style: TextStyle(fontSize: 26, fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            const Muted('Watch and control your tank from anywhere', center: true),
            const SizedBox(height: 32),
            TextField(controller: _phone, keyboardType: TextInputType.phone, autofillHints: const [AutofillHints.telephoneNumber], decoration: const InputDecoration(labelText: 'Phone number')),
            const SizedBox(height: 14),
            TextField(
              controller: _pw,
              obscureText: _hide,
              autofillHints: const [AutofillHints.password],
              onSubmitted: (_) => _login(),
              decoration: InputDecoration(labelText: 'Password', suffixIcon: IconButton(icon: Icon(_hide ? Icons.visibility_outlined : Icons.visibility_off_outlined), onPressed: () => setState(() => _hide = !_hide))),
            ),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const ForgotScreen())), child: const Text('Forgot password?')),
            ),
            if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(_error!, style: const TextStyle(color: C.bad))),
            FilledButton(onPressed: _busy ? null : _login, child: Text(_busy ? 'Logging in…' : 'Log in')),
            const SizedBox(height: 24),
            Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              const Muted('New here? ', size: 14),
              TextButton(onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const SignupScreen())), child: const Text('Create an account')),
            ]),
          ],
        ),
      ),
    );
  }
}

class SignupScreen extends StatefulWidget {
  const SignupScreen({super.key});
  @override
  State<SignupScreen> createState() => _SignupScreenState();
}

class _SignupScreenState extends State<SignupScreen> {
  final _name = TextEditingController();
  final _phone = TextEditingController(text: '+91 ');
  final _pw = TextEditingController();
  final _pw2 = TextEditingController();
  bool _busy = false;
  String? _error;

  Future<void> _submit() async {
    if (_name.text.trim().isEmpty) return setState(() => _error = 'Enter your name');
    if (_pw.text.length < 8) return setState(() => _error = 'Password must be at least 8 characters');
    if (_pw.text != _pw2.text) return setState(() => _error = 'The two passwords are not the same');
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await context.read<Session>().register(_name.text.trim(), normalizePhone(_phone.text), _pw.text);
      if (mounted) Navigator.of(context).popUntil((r) => r.isFirst);
    } catch (e) {
      if (mounted) setState(() => _error = errText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Create account')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          TextField(controller: _name, textCapitalization: TextCapitalization.words, decoration: const InputDecoration(labelText: 'Full name')),
          const SizedBox(height: 14),
          TextField(controller: _phone, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Phone number')),
          const SizedBox(height: 14),
          TextField(controller: _pw, obscureText: true, decoration: const InputDecoration(labelText: 'Password', helperText: 'At least 8 characters')),
          const SizedBox(height: 14),
          TextField(controller: _pw2, obscureText: true, onSubmitted: (_) => _submit(), decoration: const InputDecoration(labelText: 'Password again')),
          const SizedBox(height: 16),
          if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(_error!, style: const TextStyle(color: C.bad))),
          FilledButton(onPressed: _busy ? null : _submit, child: Text(_busy ? 'Creating…' : 'Create account')),
          const SizedBox(height: 12),
          const Muted('If someone shared a tank with this phone number, it shows up after you sign up.', center: true),
        ],
      ),
    );
  }
}

class ForgotScreen extends StatelessWidget {
  const ForgotScreen({super.key});
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Reset password')),
      body: ListView(padding: const EdgeInsets.all(20), children: const [
        SectionCard(children: [
          Icon(Icons.support_agent, color: C.water, size: 36),
          SizedBox(height: 10),
          Text('Contact support', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
          SizedBox(height: 6),
          Muted('Password reset by SMS is not available yet. Call or message support from the phone number of your account. They will set a new password for you, and you can change it later in Profile.', size: 14),
        ]),
      ]),
    );
  }
}
