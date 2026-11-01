import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'screens/auth_screens.dart';
import 'screens/home_shell.dart';
import 'state/live.dart';
import 'state/session.dart';
import 'theme.dart';

final navigatorKey = GlobalKey<NavigatorState>();

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final session = Session()..load();
  // logged out (expired, blocked, logout): drop any open screens so the login screen shows
  var wasLoggedIn = false;
  session.addListener(() {
    if (wasLoggedIn && !session.loggedIn) navigatorKey.currentState?.popUntil((r) => r.isFirst);
    wasLoggedIn = session.loggedIn;
  });
  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: session),
        ChangeNotifierProvider(create: (_) => Live(session)),
      ],
      child: const WaterTankApp(),
    ),
  );
}

class WaterTankApp extends StatelessWidget {
  const WaterTankApp({super.key});

  @override
  Widget build(BuildContext context) {
    final session = context.watch<Session>();
    return MaterialApp(
      navigatorKey: navigatorKey,
      title: 'Water Tank',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      themeMode: ThemeMode.light,
      home: !session.ready
          ? const Scaffold(body: Center(child: CircularProgressIndicator()))
          : session.loggedIn
              ? const HomeShell(key: ValueKey('home'))
              : const LoginScreen(key: ValueKey('login')),
    );
  }
}
