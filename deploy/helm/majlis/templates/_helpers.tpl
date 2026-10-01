{{- define "majlis.labels" -}}
app.kubernetes.io/name: majlis
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "majlis.pgHost" -}}majlis-pg-rw{{- end -}}
