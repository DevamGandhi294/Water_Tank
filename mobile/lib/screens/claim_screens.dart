import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:provider/provider.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// QR on the sticker: `WT2:<16-char token>` (new, holds no serial or MAC)
/// or `WT1:<serial>:<claimCode>` (old stickers). For WT2 the serial is empty;
/// the server finds the tank by the token.
({String serial, String code})? parseQr(String raw) {
  final t = raw.trim();
  final m2 = RegExp(r'^WT2:([0-9A-Za-z]{16})$').firstMatch(t);
  if (m2 != null) return (serial: '', code: m2.group(1)!.toUpperCase());
  final m = RegExp(r'^WT1:([^:]+):(.+)$').firstMatch(t);
  if (m == null) return null;
  return (serial: m.group(1)!, code: m.group(2)!);
}

/// "02 Nov 2026"
String fmtRegDate(String? iso) {
  final d = iso == null ? null : DateTime.tryParse(iso);
  return d == null ? '' : DateFormat('dd MMM yyyy').format(d.toLocal());
}

class ClaimScanScreen extends StatefulWidget {
  const ClaimScanScreen({super.key});
  @override
  State<ClaimScanScreen> createState() => _ClaimScanScreenState();
}

class _ClaimScanScreenState extends State<ClaimScanScreen> {
  final _serial = TextEditingController();
  final _code = TextEditingController();
  final _scanner = MobileScannerController(formats: const [BarcodeFormat.qrCode]);
  bool _busy = false;
  bool _handled = false;
  String? _error;

  Future<void> _check(String serial, String code) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await context.read<Session>().api.post('/devices/claim/check', {'serial': serial.trim(), 'claimCode': code.trim()});
      if (!mounted) return;
      await _scanner.stop();
      if (!mounted) return;
      final added = await Navigator.push<bool>(context, MaterialPageRoute(builder: (_) => ClaimNameScreen(serial: r['serial'], code: code.trim(), hwModel: r['hwModel'] ?? '', registeredAt: r['registeredAt'])));
      if (!mounted) return;
      if (added == true) {
        Navigator.pop(context, true);
      } else {
        _handled = false;
        await _scanner.start();
      }
    } catch (e) {
      if (mounted) setState(() => _error = errText(e));
      _handled = false;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _onDetect(BarcodeCapture cap) {
    if (_handled || _busy) return;
    for (final b in cap.barcodes) {
      final raw = b.rawValue;
      if (raw == null) continue;
      final p = parseQr(raw);
      if (p == null) {
        setState(() => _error = 'This QR is not a Water Tank sticker');
        continue;
      }
      _handled = true;
      if (p.serial.isNotEmpty) _serial.text = p.serial;
      _code.text = p.code;
      _check(p.serial, p.code);
      return;
    }
  }

  @override
  void dispose() {
    _scanner.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Add a tank')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(16),
          child: AspectRatio(
            aspectRatio: 1,
            child: Stack(fit: StackFit.expand, children: [
              MobileScanner(
                controller: _scanner,
                onDetect: _onDetect,
                errorBuilder: (_, err) => Container(
                  color: C.deep,
                  alignment: Alignment.center,
                  padding: const EdgeInsets.all(20),
                  child: const Text('Camera not available. Type the code from the sticker below.', textAlign: TextAlign.center, style: TextStyle(color: Colors.white)),
                ),
              ),
              IgnorePointer(
                child: Center(
                  child: Container(width: 200, height: 200, decoration: BoxDecoration(border: Border.all(color: Colors.white, width: 3), borderRadius: BorderRadius.circular(16))),
                ),
              ),
              if (_busy) Container(color: Colors.black38, child: const Center(child: CircularProgressIndicator(color: Colors.white))),
            ]),
          ),
        ),
        const SizedBox(height: 10),
        const Muted('Point the camera at the QR sticker on the box or the device', center: true),
        const SizedBox(height: 18),
        const Row(children: [Expanded(child: Divider()), Padding(padding: EdgeInsets.symmetric(horizontal: 10), child: Muted('or type it')), Expanded(child: Divider())]),
        const SizedBox(height: 14),
        TextField(controller: _code, textCapitalization: TextCapitalization.characters, decoration: const InputDecoration(labelText: 'Code on the sticker', hintText: 'K7P2-9XQM-4HTR-B2WD')),
        const SizedBox(height: 12),
        TextField(controller: _serial, textCapitalization: TextCapitalization.characters, decoration: const InputDecoration(labelText: 'Serial (only for old 8-letter codes)', hintText: 'WT-2026-00001')),
        const SizedBox(height: 12),
        if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(_error!, style: const TextStyle(color: C.bad))),
        FilledButton(onPressed: _busy ? null : () => _check(_serial.text, _code.text), child: const Text('Continue')),
      ]),
    );
  }
}

class ClaimNameScreen extends StatefulWidget {
  const ClaimNameScreen({super.key, required this.serial, required this.code, required this.hwModel, this.registeredAt});
  final String serial;
  final String? registeredAt;
  final String code;
  final String hwModel;
  @override
  State<ClaimNameScreen> createState() => _ClaimNameScreenState();
}

class _ClaimNameScreenState extends State<ClaimNameScreen> {
  final _name = TextEditingController(text: 'Home Tank');
  final _loc = TextEditingController();
  final _height = TextEditingController();
  final _cap = TextEditingController();
  bool _busy = false;
  String? _error;

  Future<void> _claim() async {
    if (_name.text.trim().isEmpty) return setState(() => _error = 'Give the tank a name');
    final h = double.tryParse(_height.text.trim());
    final c = int.tryParse(_cap.text.trim());
    if (_height.text.trim().isNotEmpty && (h == null || h < 30 || h > 1000)) return setState(() => _error = 'Tank height must be between 30 and 1000 cm');
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await context.read<Session>().api.post('/devices/claim', {
        'serial': widget.serial,
        'claimCode': widget.code,
        'name': _name.text.trim(),
        if (_loc.text.trim().isNotEmpty) 'location': _loc.text.trim(),
        if (h != null) 'tankHeightCm': h,
        if (c != null && c > 0) 'capacityLitres': c,
      });
      if (!mounted) return;
      toast(context, '${_name.text.trim()} added');
      Navigator.pop(context, true);
    } catch (e) {
      if (mounted) setState(() => _error = errText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Tank found')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        SectionCard(children: [
          Row(children: [
            Pill.ok('Available'),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(widget.serial, style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.w700)),
                if (fmtRegDate(widget.registeredAt).isNotEmpty) Muted('Registered ${fmtRegDate(widget.registeredAt)}'),
                Muted('${widget.hwModel} · main + sender board'),
              ]),
            ),
          ]),
        ]),
        const SizedBox(height: 16),
        TextField(controller: _name, textCapitalization: TextCapitalization.words, decoration: const InputDecoration(labelText: 'Tank name')),
        const SizedBox(height: 12),
        TextField(controller: _loc, textCapitalization: TextCapitalization.sentences, decoration: const InputDecoration(labelText: 'Location (optional)', hintText: 'Roof')),
        const SizedBox(height: 12),
        Row(children: [
          Expanded(child: TextField(controller: _height, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Tank height (cm)'))),
          const SizedBox(width: 12),
          Expanded(child: TextField(controller: _cap, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Capacity (L)'))),
        ]),
        const SizedBox(height: 8),
        const Muted('Height is measured from the sensor to the tank bottom. Without it the app shows cm only, not %. You can set it later.'),
        const SizedBox(height: 16),
        if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(_error!, style: const TextStyle(color: C.bad))),
        FilledButton(onPressed: _busy ? null : _claim, child: Text(_busy ? 'Adding…' : 'Add to my account')),
      ]),
    );
  }
}
