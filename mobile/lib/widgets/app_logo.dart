import 'package:flutter/material.dart';

/// Water Tank app logo (blue tank with a water drop).
/// Use on Login / Sign up / splash, e.g. `const AppLogo(size: 96)`.
class AppLogo extends StatelessWidget {
  const AppLogo({super.key, this.size = 72});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Image.asset(
      'assets/images/app_logo.png',
      width: size,
      height: size,
      filterQuality: FilterQuality.medium,
    );
  }
}
