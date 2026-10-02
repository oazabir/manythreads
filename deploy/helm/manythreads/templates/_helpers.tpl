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
