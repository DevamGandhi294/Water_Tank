import 'package:flutter/material.dart';
import '../theme.dart';

/// Tank drawing like the mockup: water level, dashed cutoff line, distance from the sensor.
class TankView extends StatelessWidget {
  const TankView({super.key, required this.levelPct, required this.distanceCm, required this.cutoffCm, required this.tankHeightCm, this.height = 230});
  final int? levelPct;
  final double? distanceCm;
  final double cutoffCm;
  final double? tankHeightCm;
  final double height;

  @override
  Widget build(BuildContext context) {
    final label = levelPct != null ? 'Tank $levelPct% full' : distanceCm != null ? 'Water ${distanceCm!.toStringAsFixed(1)} cm below the sensor' : 'No reading';
    return Semantics(
      label: label,
      child: TweenAnimationBuilder<double>(
        tween: Tween(begin: 0, end: _fill()),
        duration: const Duration(milliseconds: 600),
        builder: (_, fill, __) => CustomPaint(
          size: Size(240, height),
          painter: _TankPainter(fill: fill, cutoffFrac: _cutFrac(), distance: distanceCm, cutoff: cutoffCm),
        ),
      ),
    );
  }

  // fraction of the tank (0..1 from the bottom) that holds water
  double _fill() {
    if (tankHeightCm == null || distanceCm == null) return levelPct != null ? levelPct! / 100 : 0;
    return ((tankHeightCm! - distanceCm!) / tankHeightCm!).clamp(0.0, 1.0);
  }

  double? _cutFrac() => tankHeightCm == null ? null : (cutoffCm / tankHeightCm!).clamp(0.0, 1.0);
}

class _TankPainter extends CustomPainter {
  _TankPainter({required this.fill, required this.cutoffFrac, required this.distance, required this.cutoff});
  final double fill;
  final double? cutoffFrac;
  final double? distance;
  final double cutoff;

  @override
  void paint(Canvas canvas, Size size) {
    const top = 16.0;
    final inner = size.height - top - 8;
    final left = size.width / 2 - 62;
    final body = RRect.fromRectAndRadius(Rect.fromLTWH(left, top, 124, inner), const Radius.circular(14));
    canvas.drawRRect(body, Paint()..color = Colors.white);
    // water
    canvas.save();
    canvas.clipRRect(body);
    final waterTop = top + inner * (1 - fill);
    final rect = Rect.fromLTWH(left, waterTop, 124, top + inner - waterTop);
    canvas.drawRect(rect, Paint()..shader = const LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [C.water2, C.water]).createShader(rect));
    canvas.restore();
    canvas.drawRRect(body, Paint()
      ..color = C.line
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2);
    // sensor on the lid
    canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(size.width / 2 - 12, top - 12, 24, 10), const Radius.circular(2)), Paint()..color = C.muted);
    // distance line
    final dash = Paint()
      ..color = C.muted
      ..strokeWidth = 1;
    for (double y = top; y < waterTop - 2; y += 5) {
      canvas.drawLine(Offset(size.width / 2, y), Offset(size.width / 2, (y + 2).clamp(0, waterTop)), dash);
    }
    if (distance != null) {
      _text(canvas, '${distance!.toStringAsFixed(1)} cm', Offset(left - 8, (top + waterTop) / 2 - 7), C.muted, alignRight: true);
    }
    // cutoff line
    if (cutoffFrac != null) {
      final y = top + inner * cutoffFrac!;
      final p = Paint()
        ..color = C.bad
        ..strokeWidth = 1.5;
      for (double x = left - 6; x < left + 130; x += 7) {
        canvas.drawLine(Offset(x, y), Offset(x + 4, y), p);
      }
      _text(canvas, 'cutoff', Offset(left + 134, y - 12), C.bad);
      _text(canvas, '${cutoff.toStringAsFixed(0)} cm', Offset(left + 134, y + 1), C.bad);
    }
  }

  void _text(Canvas c, String s, Offset at, Color color, {bool alignRight = false}) {
    final tp = TextPainter(text: TextSpan(text: s, style: TextStyle(color: color, fontSize: 10.5, fontFamily: 'monospace')), textDirection: TextDirection.ltr)..layout();
    tp.paint(c, alignRight ? at.translate(-tp.width, 0) : at);
  }

  @override
  bool shouldRepaint(_TankPainter o) => o.fill != fill || o.cutoffFrac != cutoffFrac || o.distance != distance || o.cutoff != cutoff;
}

/// Small tank for the list cards
class MiniTank extends StatelessWidget {
  const MiniTank({super.key, required this.levelPct});
  final int? levelPct;
  @override
  Widget build(BuildContext context) => Container(
        width: 44,
        height: 64,
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(9), border: Border.all(color: C.line, width: 2)),
        clipBehavior: Clip.antiAlias,
        alignment: Alignment.bottomCenter,
        child: FractionallySizedBox(
          heightFactor: ((levelPct ?? 0) / 100).clamp(0.0, 1.0),
          widthFactor: 1,
          child: Container(decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [C.water2, C.water]))),
        ),
      );
}
