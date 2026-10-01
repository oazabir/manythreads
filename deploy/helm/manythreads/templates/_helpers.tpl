{{- define "manythreads.labels" -}}
app.kubernetes.io/name: manythreads
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "manythreads.pgHost" -}}manythreads-pg-rw{{- end -}}
