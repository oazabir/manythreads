{{- define "manythreads.labels" -}}
app.kubernetes.io/name: manythreads
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "manythreads.pgHost" -}}manythreads-pg-rw{{- end -}}

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
{{- if not (has $t.mode (list "none" "cloudflare" "letsencrypt")) -}}{{ fail (printf "tls.mode must be none, cloudflare or letsencrypt (got %q)" (toString $t.mode)) }}{{- end -}}
{{- if eq $t.mode "cloudflare" -}}
{{- if not (has $t.cloudflare.origin (list "strict" "flexible")) -}}{{ fail (printf "tls.cloudflare.origin must be strict or flexible (got %q)" (toString $t.cloudflare.origin)) }}{{- end -}}
{{- if and (eq $t.cloudflare.origin "strict") (not $t.cloudflare.certSecret) -}}{{ fail "tls.cloudflare.certSecret is required for tls.cloudflare.origin=strict (a kubernetes.io/tls Secret with the Cloudflare Origin CA certificate)" }}{{- end -}}
{{- end -}}
{{- if eq $t.mode "letsencrypt" -}}
{{- if not (has $t.letsencrypt.server (list "production" "staging")) -}}{{ fail (printf "tls.letsencrypt.server must be production or staging (got %q)" (toString $t.letsencrypt.server)) }}{{- end -}}
{{- if and $t.wildcard (not (and $t.letsencrypt.dns01 $t.letsencrypt.dns01.provider)) -}}{{ fail "a wildcard Let's Encrypt certificate needs tls.letsencrypt.dns01 (provider and apiTokenSecret); or set tls.wildcard=false" }}{{- end -}}
{{- if and $t.wildcard (ne $t.letsencrypt.dns01.provider "cloudflare") -}}{{ fail (printf "tls.letsencrypt.dns01.provider must be cloudflare (got %q)" (toString $t.letsencrypt.dns01.provider)) }}{{- end -}}
{{- if and $t.wildcard (not $t.letsencrypt.dns01.apiTokenSecret) -}}{{ fail "tls.letsencrypt.dns01.apiTokenSecret is required for a wildcard certificate" }}{{- end -}}
{{- end -}}
{{- $t.mode -}}
{{- end }}

{{/* Name of the Secret that holds the serving certificate ("" when the chart is not responsible for one). */}}
{{- define "manythreads.tlsSecret" -}}
{{- $m := include "manythreads.tlsMode" . -}}
{{- if and (eq $m "cloudflare") (eq .Values.tls.cloudflare.origin "strict") -}}{{ .Values.tls.cloudflare.certSecret }}
{{- else if eq $m "letsencrypt" -}}manythreads-tls
{{- end -}}
{{- end }}

{{/* Host the deployed apps live under: <app>--<team>.<appsHost>. */}}
{{- define "manythreads.appsHost" -}}
{{- .Values.hermesPods.apps.host | default .Values.domain -}}
{{- end }}
