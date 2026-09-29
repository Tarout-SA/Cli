---
name: tarout-domains
description: Connect custom domains to Tarout applications: DNS records, verification, SSL, root/apex domains, www subdomains. Use when the user wants to attach, link, or point a domain at a Tarout-hosted app, asks about Tarout DNS records or domain verification, hits a root-domain error from the tarout CLI, or needs to buy/manage a domain through Tarout.
---

# Custom domains on Tarout

External (customer-owned) domains connect through exactly one flow: **add-external → DNS records → verify → link to app**. TLS certificates are issued automatically after the records propagate. (`tarout domains link` is retired and always rejected; hostnames under a Tarout-registered/purchased domain use `tarout domains app link-registered` instead.)

## The flow

```bash
# 1. Register the hostname (creates the platform record + edge hostname).
tarout --json domains add-external www.example.com

# 2. Relay the EXACT DNS records to the user (never paraphrase values):
tarout --json domains instructions www.example.com

# 3. After the user adds the records, poll until verified (~DNS propagation + cert issuance):
tarout --json domains wait-verified www.example.com --timeout 1800 --interval 10

# 4. Attach to the app. --domain-id is the domainId from the instructions/wait-verified
#    output (NOT the one returned by add-external, which uses a different ID space); --app-id from `tarout apps list`.
tarout --json domains app link-to-app --domain-id <domain-id> --app-id <app-id>
```

Records the user creates (step 2 returns them exactly):

- **Subdomain** (`www.example.com`, `api.example.com`): one CNAME (name = the subdomain label, e.g. `www`) → the Tarout edge (e.g. `proxy.tarout.app`), plus a one-time ownership TXT `_tarout-verification.<domain>`.
- **Root/apex domain** (`example.com`): connects **only when the domain's DNS is hosted on Cloudflare**. It uses a root CNAME `@` → the Tarout edge that MUST be set to **Proxied (orange cloud)**; relay that requirement verbatim, a DNS-only root record will not route. If the domain's DNS is elsewhere, `add-external` rejects the root with guidance: connect `www.<domain>` instead and have the user add a redirect from the root at their DNS provider, or move the domain's DNS to Cloudflare and retry. Never retry a rejected root unchanged, and never suggest replacing the proxied root CNAME with an A record.

## Troubleshooting

- **Verification stuck**: confirm the records match `tarout domains instructions` exactly (relative names: `www`, not `www.example.com.example.com`); the ownership TXT must stay until verification completes.
- **CAA block**: if verification reports a CAA error, relay the exact CAA record the output provides; the user's existing CAA records are blocking the certificate authority.
- **Root domain on Cloudflare not activating**: the root CNAME is almost certainly DNS-only. It must be Proxied (orange cloud).
- Timeouts: use `--timeout 1800` (30 min) for external domains; propagation is usually minutes.

## Buying/managing domains through Tarout

`tarout domains register <name>` (search + purchase, managed Cloudflare zone, DNS fully managed, so apex and www work automatically), `tarout domains list|info|renew|dns list|dns add`. For hostnames under such a domain: `tarout domains app link-registered`.

Full reference: https://tarout.sa/docs/for-ai/cli-reference.md. Deploy flow: the tarout-deploy skill.
