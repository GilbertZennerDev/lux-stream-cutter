# SSL "bad certificate" on Mac — diagnosis plan

## What the symptoms tell us

- Fails on **all three URLs**, including `lux-stream-cutter.lovable.app` (Lovable's own subdomain with a wildcard cert Lovable manages).
- Fails in **Safari, Chrome and Firefox** on the same Mac.
- Fails on **every Mac on one specific network**, but presumably works elsewhere (phones on cellular, other networks).

If it were a Lovable cert problem, it would fail for everyone on every network — it doesn't. If it were `luxstream.dev` DNS/SSL, `*.lovable.app` would still load — it doesn't. Three different browsers share almost nothing except the OS trust store and the network path.

**Conclusion: the TLS handshake is being intercepted or blocked on that network** (corporate/school firewall doing SSL inspection, an antivirus with HTTPS scanning, a captive-portal / DNS-hijacking router, or a MITM proxy presenting its own cert). Nothing in this codebase can fix that.

## Verification steps (no code changes)

Ask the user to run, from an affected Mac:

1. Load `https://www.apple.com` and `https://www.google.com` — if those also warn, the network is doing TLS interception on everything and IT/the router owns the fix.
2. Tether the Mac to a phone hotspot and reload `https://lux-stream-cutter.lovable.app`. If it works on cellular, the office/home network is the culprit — confirmed.
3. On the affected Mac, open the warning → **Show Certificate** and read **"Issued by"**. If it's anything other than a public CA like *Let's Encrypt*, *Google Trust Services*, *Cloudflare*, or *Sectigo* (e.g. it names the company firewall, "Fortinet", "Zscaler", "Kaspersky", "ESET", the router brand, or "self-signed") → confirmed MITM/inspection.
4. Run in Terminal: `curl -vI https://lux-stream-cutter.lovable.app` and share the `subject:` / `issuer:` lines from the TLS handshake block.

## Likely fixes (all outside the app)

- **Corporate/school network**: ask IT to allow-list `*.lovable.app`, `luxstream.dev`, `www.luxstream.dev` in their SSL inspection appliance, or install the company root CA on the Mac.
- **Antivirus with HTTPS scanning** (Kaspersky, ESET, Bitdefender, Avast): disable "Scan encrypted / SSL connections" or add the domains to its exclusions.
- **Router / DNS**: switch the Mac's DNS to `1.1.1.1` or `8.8.8.8` and retry; reboot the router; disable any "family filter" / "safe browsing" feature.
- **Date/time**: confirm the Mac's clock is correct — a wrong clock invalidates every certificate.
- **Keychain**: in Keychain Access, remove any expired or manually-trusted certificates for `*.lovable.app` / `luxstream.dev`.

## What I will change in the code

Nothing. This is not reproducible from other networks and not caused by anything in the repo — writing code would not affect it.

## If step 2 (hotspot) also fails

Then it really is a hosting-side certificate issue and the next step is to open a Lovable support ticket with:
- the exact "Issued by" and expiry from **Show Certificate**,
- output of `curl -vI https://lux-stream-cutter.lovable.app`,
- the affected URL(s).

I can help draft that message once we have the info from step 3.
