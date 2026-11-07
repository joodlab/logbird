# Cloud ingress, DNS and TLS

Status: operator procedure, 2026-11-07; no cluster, certificate or external-IP acceptance
has been executed. Run on approved Linux infrastructure from a private release copy.
Operator tooling: version-matched kubectl, standalone Kustomize, curl, dig and
OpenSSL; restore hosts also need the pinned database clients, rclone and age.

## Bootstrap and client address path

Phase 1 uses **direct client -> node public IP -> ServiceLB -> Traefik -> app -> API**.
Choose `externalTrafficPolicy: Local`; no Hetzner LB, CDN, PROXY protocol or HTTP proxy
sits in front. Traefik runs on each explicitly selected edge node. Local delivery
avoids cross-node source masquerading; publish only nodes with a ready local Traefik.
See [K3s networking](https://docs.k3s.io/networking/networking-services) and the
[Traefik chart example](https://github.com/traefik/traefik-helm-chart/blob/master/EXAMPLES.md#set-externaltrafficpolicy-local-for-traefik-service).

1. Provision the approved VMs/private network and firewalls. Public TCP 80/443 goes
   only to edge nodes; SSH and Kubernetes 6443 are operator/VPN-only. Permit required
   K3s inter-node ports only within the private network; never expose databases,
   NodePorts or the Traefik dashboard. Choose actual interface/private IP values
   using [K3s network requirements](https://docs.k3s.io/installation/requirements#networking).
2. Pin an approved supported release; the example pin is `v1.35.10+k3s1` (October
   2026 release). Save installer/artifact hashes, OS image and config in the release
   receipt. Review the downloaded installer before executing it on the new host:

   ```sh
   curl --fail --location https://get.k3s.io --output k3s-install.sh
   # Review installer; prepare /etc/rancher/k3s/config.yaml with private node-ip,
   # flannel-iface and secrets-encryption: true. Keep its token/config private.
   sudo env INSTALL_K3S_VERSION='v1.35.10+k3s1' sh ./k3s-install.sh server --cluster-init
   sudo k3s kubectl get nodes -o wide
   ```

   Starting embedded etcd on the single server permits later addition of two servers;
   one server has no quorum redundancy. Keep bundled ServiceLB and Traefik enabled.
   At phase 2, join two servers with the same pinned config/version, private token
   file and fixed private registration endpoint; follow [HA embedded etcd](https://docs.k3s.io/datastore/ha-embedded).
   Test quorum loss, node placement and spare workload capacity before an HA claim.
3. In the approved kubeconfig context, label the phase-1 server and apply the
   controller configuration **before DNS or application Ingress**:

   ```sh
   : "${EDGE_NODE:?Set the selected Kubernetes node name}"
   kubectl label node "$EDGE_NODE" logbird.io/edge=true \
     svccontroller.k3s.cattle.io/enablelb=true \
     svccontroller.k3s.cattle.io/lbpool=logbird-edge --overwrite
   kubectl -n kube-system apply -f platform/traefik-config.yaml
   kubectl -n kube-system rollout status daemonset/traefik --timeout=300s
   kubectl -n kube-system get service traefik -o jsonpath='{.spec.externalTrafficPolicy}{"\n"}'
   # Required output: Local. Confirm one ready Traefik on each published edge node.
   ```

   The HelmChartConfig uses the chart-v40+ `service.spec` keys; merge into any
   existing configuration rather than creating a second object. Reject a chart
   upgrade that silently resets Local. Leave forwarded-header and PROXY trust off
   for this direct path. An external HTTP proxy requires its exact trusted source
   ranges at Traefik plus a new spoofing/IP test; do not enable insecure trust.

`TRUST_PROXY=2` counts **Traefik + app**, each contributing a trusted X-Forwarded-For
entry. The API selects the second entry from the right. A TCP LB with correctly
trusted PROXY protocol adds no HTTP hop; an HTTP-mode LB or CDN adds one (then 3),
provided that its forwarding chain is authenticated and appended correctly. Adding
either is a separate design/qualification step. Never expose the API directly with
this trust setting. See [address selection](../apps/server/src/client-address.ts)
and [app proxy](../apps/app/server/proxy.ts).

## DNS and certificate lifecycle

Use **cert-manager ACME HTTP-01**, with its own challenge Ingress independent of
the application fence. TCP 80 remains reachable for ACME; the app Ingress listens
only on `websecure`, so ordinary HTTP must return 404 rather than serve the app.
Do not add a global port-80 redirect that intercepts the solver. A whole-edge
firewall fence must preserve challenge access or use a separately reviewed DNS-01
solver. The operator allowlist below is scoped to the application Ingress.

1. Replace `audit.example.test` in `config.yaml`, `edge/ingress.yaml` and
   `platform/certificates.yaml`; replace issuer email and `MAIL_FROM`. At the DNS
   provider create an **A** record for that host to the selected edge node public
   IPv4, TTL 300 during commissioning. Publish AAAA only after IPv6 routing,
   firewall, Local delivery and both-IP acceptance work end to end. Remove stale
   A/AAAA records, and check any CAA permits `letsencrypt.org`.

   ```sh
   : "${PUBLIC_HOST:?Set the approved real hostname}"
   dig +short A "$PUBLIC_HOST"
   dig +short AAAA "$PUBLIC_HOST"
   dig +short CAA "$PUBLIC_HOST"
   ```

2. From the repo root, download/review a pinned cert-manager release and install it
   as a separately approved platform component. Example pin from the
   [official installation guide](https://cert-manager.io/docs/installation/kubectl/):

   ```sh
   curl --fail --location --output cert-manager-v1.21.3.yaml \
     https://github.com/cert-manager/cert-manager/releases/download/v1.21.3/cert-manager.yaml
   # Record SHA256 and review cluster-wide permissions before apply.
   kubectl apply -f cert-manager-v1.21.3.yaml
   kubectl -n cert-manager rollout status deployment/cert-manager --timeout=300s
   kubectl -n cert-manager rollout status deployment/cert-manager-webhook --timeout=300s
   kubectl -n cert-manager rollout status deployment/cert-manager-cainjector --timeout=300s
   ```

3. From the private `deploy/k3s` copy, prepare namespace/network policies, allow
   only Traefik to solver port 8089, then apply the example staging issuer/certificate:

   ```sh
   kubectl apply -f namespace.yaml
   kubectl -n logbird apply -f network-policies.yaml
   kubectl -n logbird apply -f platform/acme-network-policy.yaml -f platform/certificates.yaml
   kubectl -n logbird wait --for=condition=Ready certificate/logbird-origin --timeout=300s
   kubectl -n logbird get certificate,certificaterequest,order,challenge
   ```

   Repository application objects carry `metadata.namespace: logbird`, including
   raw NetworkPolicies; `-n logbird` is also explicit on their apply commands.
   The sole repo-owned platform exception is Traefik's HelmChartConfig in
   `kube-system`. The upstream cert-manager installation bundle declares its own
   platform namespaces; do not rewrite that bundle into the application namespace.

   Verify staging challenge issuance, hostname and Secret references. The staging
   certificate is untrusted and cannot pass production HTTPS acceptance. In the
   private copy change the ClusterIssuer's `metadata.name` to `logbird-acme-production`,
   ACME server to `https://acme-v02.api.letsencrypt.org/directory`, account Secret
   name to `logbird-acme-production-account`, and the Certificate's `issuerRef.name`
   to `logbird-acme-production`. Reapply `platform/certificates.yaml`: changing
   issuerRef requests reissuance without deleting the staging issuer/account.
   Wait for Ready and inspect the **new** production issuer, serial and revision;
   a still-Ready old staging certificate is insufficient. Inspect public certificate
   metadata without exposing its private key:

   ```sh
   kubectl -n logbird get certificate logbird-origin -o yaml
   kubectl -n logbird get secret logbird-origin-tls -o jsonpath='{.data.tls\.crt}' \
     | base64 --decode | openssl x509 -noout -issuer -serial -dates -ext subjectAltName
   ```

   Preserve issuer keys; record real chain/SNI and renewal proof, and alert at 21/7 days.
   [HTTP-01 configuration](https://cert-manager.io/docs/configuration/acme/http01/)
   describes the challenge route. Confirm solver Pods satisfy namespace Pod Security.

## Fence and operator acceptance window

The [release sequence](cloud-operations.md#execute-the-qualified-release) deletes
the application Ingress before stopping writers. Base `kubectl -n logbird apply -k .` excludes
the entire `edge/` directory and cannot recreate it. Inventory and fence any other
routes to the same app/API; direct stores/writers need their own administrator fence.

Functional acceptance uses a local-only tunnel; it opens no public route:

```sh
kubectl -n logbird port-forward --address 127.0.0.1 service/logbird-app 4600:4600
# In a second terminal: BASE_URL=http://127.0.0.1:4600 pnpm smoke:prod
```

An HTTPS-only APP_URL can prevent cookie/origin-sensitive login through this tunnel.
Use it for health/ingest/read checks; do login, cookies and headers in the edge window.
After functional checks, replace the two reserved addresses in
`edge/operator-window.yaml` with the operators' actual public /32 or /128 addresses:

```sh
kubectl -n logbird apply -k edge
kubectl -n logbird get ingress logbird -o yaml
```

This opens only those two sources; a third, non-allowlisted source must receive 403.
From that third source, record
`curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' "https://$PUBLIC_HOST/readyz"`:
expect 404 while fenced and 403 in this window, never 200.
Test real TLS/SNI without `-k`, Secure/HttpOnly/SameSite cookies, hostile forwarded
headers, HTTPS origin/CORS and the following rate-limit separation. No fixture keys
or codes belong in logs/receipts.

### Two-IP rate-limit acceptance

Use two independently routed operator hosts (not two interfaces behind one NAT),
the same non-mailing auth POST and one fixed-minute window. This test is required
for releases and edge/proxy/rate-limit changes, not each unchanged nightly backup.
Do not lower live limits. Use **POST `/api/auth/sign-out` with no session/cookie**
and the valid Origin header: it exercises the shared auth limiter without sending
mail or changing a real session. From A make `AUTH_RATE_LIMIT_PER_MINUTE + 1` calls
and confirm Logbird's 429/Retry-After. Immediately call from B: it must reach the
sign-out handler rather than A's limiter. Keep provider SMTP entirely out of this test.

With the Redis administrator, verify exactly two SHA256 source-address suffixes
for that window's `{logbird}:rate:auth:POST:/api/auth/*:<digest>:<window>` keys,
without printing IPs, addresses or credentials. Repeat through each published node;
forged X-Forwarded-For from A must not evade A's bucket. Record the IP-to-digest
mapping privately. If all calls collapse to one bucket, keep the Ingress closed,
check Local/local endpoints and TRUST_PROXY; never raise the global limit to hide it.
All auth POSTs from one source share the `/api/auth/*` route bucket, independent of
the concrete auth endpoint. The proposed warning is tracked in OPS-09; low traffic alone cannot
diagnose a broken proxy.

## Unfence and refence

For releases, require all release gates and both acceptance routes before the
release owner authorizes reopening. Unchanged nightly captures use the reduced
[readiness/canary reopen procedure](backup-disaster-recovery.md#capture-procedure)
instead; they do not repeat the two-host commissioning test. Remove the one known
acceptance middleware annotation only after the applicable checks pass:

```sh
kubectl -n logbird annotate ingress logbird \
  traefik.ingress.kubernetes.io/router.middlewares-
# Observe external probes/ingest/readback. Keep the operator-window object for refencing.
```

If other middleware is later introduced, preserve its entries when removing only
`logbird-operator-window@kubernetescrd`. Refence on any failure:

```sh
kubectl -n logbird delete ingress logbird --ignore-not-found --wait=true
```

Stop the port-forward with Ctrl-C. Check no public application route remains and
stop/drain writers before data repair. Deleting an Ingress is asynchronous at the
controller: prove rejection from a non-allowlisted external host before a backup
boundary, and close existing sessions/drain requests. ACME solver routes may remain.
