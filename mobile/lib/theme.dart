import 'package:flutter/material.dart';

/// Light theme only. Colors from docs/ui-mockup.html.
class C {
  static const bg = Color(0xFFF7FAFB);
  static const panel = Color(0xFFFFFFFF);
  static const ink = Color(0xFF14232A);
  static const muted = Color(0xFF5B6F77);
  static const line = Color(0xFFD5DFE2);
  static const water = Color(0xFF1F7FB8);
  static const water2 = Color(0xFF7CC4E8);
  static const waterSoft = Color(0xFFDCEEF8);
  static const deep = Color(0xFF0E3A52);
  static const ok = Color(0xFF1D8A52);
  static const okSoft = Color(0xFFDCF2E6);
  static const warn = Color(0xFFB26A00);
  static const warnSoft = Color(0xFFFBEED5);
  static const bad = Color(0xFFC2372F);
  static const badSoft = Color(0xFFFBE1DF);
}

ThemeData buildTheme() {
  final base = ThemeData(
    useMaterial3: true,
    brightness: Brightness.light,
    colorScheme: ColorScheme.fromSeed(seedColor: C.water, brightness: Brightness.light, primary: C.water, surface: C.panel, error: C.bad),
    scaffoldBackgroundColor: C.bg,
  );
  final border = OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: C.line));
  return base.copyWith(
    appBarTheme: const AppBarTheme(backgroundColor: C.bg, foregroundColor: C.ink, elevation: 0, scrolledUnderElevation: 0, centerTitle: false,
        titleTextStyle: TextStyle(color: C.ink, fontSize: 20, fontWeight: FontWeight.w700)),
    textTheme: base.textTheme.apply(bodyColor: C.ink, displayColor: C.ink),
    cardTheme: CardThemeData(color: C.panel, elevation: 0, margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: const BorderSide(color: C.line))),
    inputDecorationTheme: InputDecorationTheme(filled: true, fillColor: Colors.white, border: border, enabledBorder: border,
        focusedBorder: border.copyWith(borderSide: const BorderSide(color: C.water, width: 1.5)),
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14), labelStyle: const TextStyle(color: C.muted)),
    filledButtonTheme: FilledButtonThemeData(style: FilledButton.styleFrom(backgroundColor: C.water, foregroundColor: Colors.white,
        minimumSize: const Size.fromHeight(48), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15))),
    outlinedButtonTheme: OutlinedButtonThemeData(style: OutlinedButton.styleFrom(foregroundColor: C.water, minimumSize: const Size.fromHeight(48),
        side: const BorderSide(color: C.line), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15))),
    dividerTheme: const DividerThemeData(color: C.line, space: 1, thickness: 1),
    navigationBarTheme: NavigationBarThemeData(backgroundColor: C.panel, indicatorColor: C.waterSoft,
        labelTextStyle: WidgetStateProperty.all(const TextStyle(fontSize: 12, fontWeight: FontWeight.w500))),
    switchTheme: SwitchThemeData(thumbColor: WidgetStateProperty.all(Colors.white),
        trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? C.water : C.line),
        trackOutlineColor: WidgetStateProperty.all(Colors.transparent)),
    snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating, backgroundColor: C.deep),
  );
}
