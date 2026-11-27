{{- define "manythreads.labels" -}}
app.kubernetes.io/name: manythreads
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "manythreads.pgHost" -}}manythreads-pg-rw{{- end -}}

{{- /*
  A second release on the same cluster (docs/deploy.md, "a second release on the same cluster"). Everything the chart makes outside a namespace has one name per
  cluster, so a second release needs names of its own. `clusterScopedSuffix` is empty for the first (the live site: nothing changes there) and a short word
  (lowercase letters, digits, dashes) for the second:
    manythreads.clusterSuffix   "" or "-<suffix>", appended to the names of the cluster-wide admission policy and its binding
    manythreads.appsMark        the value of the namespace label manythreads.io/apps: "true" for the first release, the suffix for the second. The
                                admission policy of EACH release selects the apps namespaces by this label; with "true" on both, the first release's rules
                                (its host name) would be applied to the second release's apps namespaces too, and refuse every app there.
  The ClusterRole of the nodes reader already carries the release namespace in its name.
*/ -}}
{{- define "manythreads.clusterSuffix" -}}
{{- $s := .Values.clusterScopedSuffix | default "" | toString -}}
{{- if $s -}}
{{- if eq $s "true" }}{{ fail "clusterScopedSuffix may not be \"true\" (it is the value the first release puts on its apps namespaces)" }}{{ end -}}
{{- if not (regexMatch "^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$" $s) }}{{ fail (printf "clusterScopedSuffix %q must be 1 to 32 lowercase letters, digits and dashes, starting and ending with a letter or digit" $s) }}{{ end -}}
-{{ $s }}
{{- end -}}
{{- end -}}
{{- define "manythreads.appsMark" -}}
{{- .Values.clusterScopedSuffix | default "true" | toString -}}
{{- end -}}

{{- /*
  Attachment store environment, shared by the server Deployment and the seed Job (both must name the same store).
  MANYTHREADS_STORAGE is local or s3 (anything else is a mistake that must stop the render, as it stops the server).
  The S3 credentials are Secret references, never values in the pod spec; with no Secret configured the pod's AWS credential chain applies.
*/ -}}
{{- define "manythreads.s3SecretName" -}}
{{- .Values.server.storage.s3.existingSecret | default "manythreads-s3" -}}
{{- end -}}

{{- define "manythreads.s3HasCredentials" -}}
{{- if or .Values.server.storage.s3.existingSecret (and .Values.server.storage.s3.accessKey .Values.server.storage.s3.secretKey) }}yes{{ end -}}
{{- end -}}

{{- define "manythreads.storageEnv" -}}
{{- $st := .Values.server.storage -}}
{{- if not (has $st.type (list "local" "s3")) }}{{ fail "server.storage.type must be local or s3" }}{{ end }}
- { name: MANYTHREADS_STORAGE, value: {{ $st.type | quote }} }
{{- if eq $st.type "s3" }}
{{- if not $st.s3.bucket }}{{ fail "server.storage.s3.bucket is required when server.storage.type is s3" }}{{ end }}
{{- if or (and $st.s3.accessKey (not $st.s3.secretKey)) (and $st.s3.secretKey (not $st.s3.accessKey)) }}{{ fail "server.storage.s3.accessKey and secretKey are set together or not at all" }}{{ end }}
- { name: MANYTHREADS_S3_BUCKET, value: {{ $st.s3.bucket | quote }} }
- { name: MANYTHREADS_S3_REGION, value: {{ $st.s3.region | quote }} }
- { name: MANYTHREADS_S3_PREFIX, value: {{ $st.s3.prefix | quote }} }
- { name: MANYTHREADS_S3_FORCE_PATH_STYLE, value: {{ ternary "true" "false" (default false $st.s3.forcePathStyle) | quote }} }
{{- if $st.s3.endpoint }}
- { name: MANYTHREADS_S3_ENDPOINT, value: {{ $st.s3.endpoint | quote }} }
{{- end }}
{{- if include "manythreads.s3HasCredentials" . }}
- name: MANYTHREADS_S3_ACCESS_KEY
  valueFrom: { secretKeyRef: { name: {{ include "manythreads.s3SecretName" . }}, key: {{ $st.s3.accessKeyKey }} } }
- name: MANYTHREADS_S3_SECRET_KEY
  valueFrom: { secretKeyRef: { name: {{ include "manythreads.s3SecretName" . }}, key: {{ $st.s3.secretKeyKey }} } }
{{- end }}
{{- end }}
{{- end -}}

{{/* The tls block, checked and normalised. Fails the render on a combination that cannot work. */}}
{{- define "manythreads.tlsMode" -}}
{{- if not (regexMatch "^[0-9]+$" (toString .Values.server.trustProxy)) -}}{{ fail (printf "server.trustProxy must be a whole number (got %q)" (toString .Values.server.trustProxy)) }}{{- end -}}
{{- $t := .Values.tls -}}
{{- $wc := include "manythreads.wildcard" . -}}
{{- if not (has $t.mode (list "none" "cloudflare" "letsencrypt" "selfsigned")) -}}{{ fail (printf "tls.mode must be none, cloudflare, letsencrypt or selfsigned (got %q)" (toString $t.mode)) }}{{- end -}}
{{- if and (eq $t.mode "selfsigned") (not (and $t.selfSigned (hasKey $t.selfSigned "duration"))) -}}{{ fail "tls.selfSigned.duration is required for tls.mode=selfsigned (for example 87600h)" }}{{- end -}}
{{- if eq $t.mode "cloudflare" -}}
{{- if not (has $t.cloudflare.origin (list "strict" "flexible")) -}}{{ fail (printf "tls.cloudflare.origin must be strict or flexible (got %q)" (toString $t.cloudflare.origin)) }}{{- end -}}
{{- if and (eq $t.cloudflare.origin "strict") (not $t.cloudflare.certSecret) -}}{{ fail "tls.cloudflare.certSecret is required for tls.cloudflare.origin=strict (a kubernetes.io/tls Secret with the Cloudflare Origin CA certificate)" }}{{- end -}}
{{- end -}}
{{- if eq $t.mode "letsencrypt" -}}
{{- if not (has $t.letsencrypt.server (list "production" "staging")) -}}{{ fail (printf "tls.letsencrypt.server must be production or staging (got %q)" (toString $t.letsencrypt.server)) }}{{- end -}}
{{- if and $wc (not (and $t.letsencrypt.dns01 $t.letsencrypt.dns01.provider)) -}}{{ fail "a wildcard Let's Encrypt certificate needs tls.letsencrypt.dns01 (provider and apiTokenSecret); or set tls.wildcard=false (or hermesPods.apps.routing=path, which needs no wildcard)" }}{{- end -}}
{{- if and $wc (ne $t.letsencrypt.dns01.provider "cloudflare") -}}{{ fail (printf "tls.letsencrypt.dns01.provider must be cloudflare (got %q)" (toString $t.letsencrypt.dns01.provider)) }}{{- end -}}
{{- if and $wc (not $t.letsencrypt.dns01.apiTokenSecret) -}}{{ fail "tls.letsencrypt.dns01.apiTokenSecret is required for a wildcard certificate" }}{{- end -}}
{{- end -}}
{{- $t.mode -}}
{{- end }}

{{/* Name of the Secret that holds the serving certificate ("" when the chart is not responsible for one). */}}
{{- define "manythreads.tlsSecret" -}}
{{- $m := include "manythreads.tlsMode" . -}}
{{- if and (eq $m "cloudflare") (eq .Values.tls.cloudflare.origin "strict") -}}{{ .Values.tls.cloudflare.certSecret }}
{{- else if or (eq $m "letsencrypt") (eq $m "selfsigned") -}}manythreads-tls
{{- end -}}
{{- end }}

{{/* How deployed apps are reached: `path` (https://<domain>/apps/<team>/<app>/, the default) or `host` (https://<app>--<team>.<appsHost>/). */}}
{{- define "manythreads.appsRouting" -}}
{{- $r := .Values.hermesPods.apps.routing | default "path" -}}
{{- if not (has $r (list "path" "host")) -}}{{ fail (printf "hermesPods.apps.routing must be path or host (got %q)" (toString $r)) }}{{- end -}}
{{- $r -}}
{{- end }}

{{/* Non-empty when a wildcard certificate (*.<domain>) is wanted: only `host` routing needs one. */}}
{{- define "manythreads.wildcard" -}}
{{- if and .Values.tls.wildcard (eq (include "manythreads.appsRouting" .) "host") }}yes{{ end -}}
{{- end }}

{{/* Host of the deployed apps. `host` routing: <app>--<team>.<appsHost>. `path` routing: the platform's own domain (apps are paths under it). */}}
{{- define "manythreads.appsHost" -}}
{{- if eq (include "manythreads.appsRouting" .) "path" -}}{{ .Values.domain }}{{- else -}}{{ .Values.hermesPods.apps.host | default .Values.domain }}{{- end -}}
{{- end }}

{{/*
  The Kubernetes API address as a pod reaches it (after service NAT), as a CIDR, for network policies that let a pod call the API.
  hermesPods.apiServer.cidr wins; otherwise it is looked up from the `kubernetes` endpoints, and `helm template` (no cluster) must be given it.
*/}}
{{- define "manythreads.apiServerCidr" -}}
{{- $cidr := .Values.hermesPods.apiServer.cidr -}}
{{- if not $cidr -}}
{{- $ep := lookup "v1" "Endpoints" "default" "kubernetes" -}}
{{- if and $ep $ep.subsets -}}{{ $cidr = printf "%s/32" (index (index $ep.subsets 0).addresses 0).ip }}{{ else }}{{ fail "hermesPods.apiServer.cidr is required: the chart could not look up the Kubernetes API address (helm template has no cluster); set it, e.g. 10.0.2.15/32" }}{{ end -}}
{{- end -}}
{{- $cidr -}}
{{- end }}

{{/*
  A RuntimeClass named in the values must exist in the cluster (PLAN P10-08, decision E22): a pod that names a class the cluster lacks never starts. Call with
  (dict "root" $ "value" <the name> "key" "<the values key>"); prints the name ("" = the cluster's default runtime). `helm template` has no cluster, so hermesPods.runtimeClassCheck=false
  skips the look-up there; on an install or an upgrade the look-up is real and a missing class stops the release with a plain message.
*/}}
{{- define "manythreads.runtimeClass" -}}
{{- $name := toString .value -}}
{{- if $name -}}
{{- if not (regexMatch "^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$" $name) -}}{{ fail (printf "%s %q is not a valid RuntimeClass name (lowercase letters, digits, dashes and dots)" .key $name) }}{{- end -}}
{{- if .root.Values.hermesPods.runtimeClassCheck -}}
{{- $rc := lookup "node.k8s.io/v1" "RuntimeClass" "" $name -}}
{{- if not $rc -}}{{ fail (printf "%s is %q, but this cluster has no RuntimeClass of that name (see: kubectl get runtimeclass). Install the sandbox runtime and its RuntimeClass first, or leave %s empty to use the cluster's default runtime. (helm template has no cluster: set hermesPods.runtimeClassCheck=false there.)" .key $name .key) }}{{- end -}}
{{- end -}}
{{- end -}}
{{- $name -}}
{{- end }}

{{/* An image reference from a name and the release tag. A name that already carries a digest (`name@sha256:...`) is used as it is: a digest is the whole address. */}}
{{- define "manythreads.imageRef" -}}
{{- if contains "@" .image -}}{{ .image }}{{- else -}}{{ .image }}:{{ .tag }}{{- end -}}
{{- end }}

{{/* The names that reach this site: the main `domain` first, then `extraDomains` (a custom name mapped later, or the address name the install started with). */}}
{{- define "manythreads.allDomains" -}}
{{- $all := list .Values.domain -}}
{{- range (.Values.extraDomains | default list) -}}{{- if not (has . $all) -}}{{- $all = append $all . -}}{{- end -}}{{- end -}}
{{- join "," $all -}}
{{- end }}

{{/* Voice rooms (media.yaml): the address browsers connect to. `media.publicUrl` wins; empty with `media.ingressPath` set = wss://<domain><ingressPath>, so a domain change keeps calls working. */}}
{{- define "manythreads.mediaPublicUrl" -}}
{{- if .Values.media.publicUrl -}}{{ .Values.media.publicUrl }}
{{- else if .Values.media.ingressPath -}}
{{- if or (not (hasPrefix "/" .Values.media.ingressPath)) (hasSuffix "/" .Values.media.ingressPath) }}{{ fail "media.ingressPath must start with / and not end with / (for example /livekit)" }}{{ end -}}
wss://{{ .Values.domain }}{{ .Values.media.ingressPath }}
{{- else -}}{{ fail "media.enabled needs media.publicUrl (the wss:// address browsers connect to), or media.ingressPath (then it is wss://<domain><ingressPath>)" }}
{{- end -}}
{{- end }}

{{/* Voice rooms: the LiveKit server's config file (LiveKit v1.13.11 key names, checked against its config-sample.yaml). The file is also hashed into the pod's checksum/config annotation, so a changed setting restarts the pod. */}}
{{- define "manythreads.mediaConfig" -}}
{{- $m := .Values.media -}}
{{- $t := $m.turn -}}
{{- $cidr := "^[0-9a-fA-F:.]+/[0-9]{1,3}$" -}}
{{- if and $t.enabled (not $t.domain) }}{{ fail "media.turn.enabled needs media.turn.domain (the name TURN is reached on, for example turn.example.org)" }}{{ end -}}
{{- if and $t.enabled (le (int $t.tlsPort) 0) (le (int $t.udpPort) 0) }}{{ fail "media.turn.enabled needs media.turn.udpPort or media.turn.tlsPort (both are 0)" }}{{ end -}}
{{- if and $t.enabled (lt (int $t.relayPortEnd) (int $t.relayPortStart)) }}{{ fail "media.turn.relayPortEnd must not be below media.turn.relayPortStart" }}{{ end -}}
{{- if and $t.enabled (le (int $t.relayPortStart) (int $m.rtcPortEnd)) (ge (int $t.relayPortEnd) (int $m.rtcPortStart)) }}{{ fail "media.turn.relayPortStart-relayPortEnd must not overlap media.rtcPortStart-rtcPortEnd (the TURN relay and the audio need ports of their own)" }}{{ end -}}
{{- range $p := (list $m.rtcTcpPort $t.udpPort $t.tlsPort) }}{{ if and $t.enabled (gt (int $p) 0) (le (int $t.relayPortStart) (int $p)) (ge (int $t.relayPortEnd) (int $p)) }}{{ fail (printf "media.turn.relayPortStart-relayPortEnd must not contain the port %d (rtcTcpPort, turn.udpPort or turn.tlsPort)" (int $p)) }}{{ end }}{{ end -}}
{{- range concat ($t.allowRestrictedPeerCidrs | default list) ($t.denyPeerCidrs | default list) }}{{ if not (regexMatch $cidr (toString .)) }}{{ fail (printf "media.turn peer address lists take CIDRs such as 10.0.0.0/8 (got %q)" (toString .)) }}{{ end }}{{ end -}}
port: 7880
log_level: info
rtc:
  port_range_start: {{ $m.rtcPortStart }}
  port_range_end: {{ $m.rtcPortEnd }}
  tcp_port: {{ $m.rtcTcpPort }}
  {{- if $m.nodeIp }}
  # Behind NAT (a machine with no public address): the address people reach it on is not on the machine, so it is given here.
  node_ip: {{ $m.nodeIp | quote }}
  {{- end }}
  use_external_ip: {{ $m.useExternalIp }}
  {{- if $m.advertiseInternalIp }}
  # Also tell browsers the machine's own (private) address, for people on the same network when the machine cannot reach its public address from inside.
  advertise_internal_ip: true
  {{- end }}
room:
  auto_create: false
  empty_timeout: 300
  max_participants: {{ $m.maxParticipants }}
webhook:
  api_key: __API_KEY__
  urls:
    - http://manythreads-server:{{ .Values.server.port }}/api/meetings/media-webhook
{{- if $t.enabled }}
turn:
  enabled: true
  domain: {{ $t.domain | quote }}
  {{- if gt (int $t.udpPort) 0 }}
  udp_port: {{ $t.udpPort }}
  {{- end }}
  {{- if gt (int $t.tlsPort) 0 }}
  tls_port: {{ $t.tlsPort }}
  external_tls: true
  {{- end }}
  relay_range_start: {{ $t.relayPortStart }}
  relay_range_end: {{ $t.relayPortEnd }}
  {{- with $t.allowRestrictedPeerCidrs }}
  allow_restricted_peer_cidrs:
    {{- range . }}
    - {{ . | quote }}
    {{- end }}
  {{- end }}
  {{- with $t.denyPeerCidrs }}
  deny_peer_cidrs:
    {{- range . }}
    - {{ . | quote }}
    {{- end }}
  {{- end }}
{{- end }}
{{- end }}
