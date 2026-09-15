{{/*
The pod template every Deployment of this chart renders (docs/CONTEXT.md §4.40): the
studio's, and the workers' and the agent's when a release runs them beside it. One
template so a change to a mount, a probe or a secret reference reaches every role at
once. Called with a dict:
  root        the chart's own context
  role        studio | agent | worker - what the pod serves, as DBPORTAL_ROLE tells the image
  labels      the pod's labels, rendered by the caller (the role's own name label)
  resources   the container's resources
  dataVolume  "shared" mounts the release's data volume (the PVC when persistence is on),
              "own" gives the pod an emptyDir - the agent role keeps nothing there
*/}}
{{- define "dbportal.podTemplate" -}}
{{- $p := . -}}
{{- $root := $p.root -}}
template:
  metadata:
    annotations:
      checksum/config: {{ include (print $root.Template.BasePath "/configmap.yaml") $root | sha256sum }}
      checksum/secret: {{ include (print $root.Template.BasePath "/secret.yaml") $root | sha256sum }}
      {{- /* The tuning document, and only when this chart is the one rendering it.
             Without this the feature silently does not update: a `helm upgrade` with a new
             agent.modelTuning.document rewrites the ConfigMap and leaves the pod template
             untouched, so nothing rolls - and the app reads the file once per process, so the
             running pods keep the profile they started with until something unrelated restarts
             them. The operator changed a value, the chart took it, and the agent goes on
             running the old settings.
             Rendered only for the INLINE document, because an existingConfigMap is the
             operator's own object: this chart renders nothing for it and so has nothing to
             hash, and a constant here would be a trigger that never fires pretending to be one.
             Rolling after editing that ConfigMap is the operator's move, and the README says so.
             Conditional rather than always-on so an install not using the feature gains no
             annotation, and therefore no restart, on the upgrade that adds this. */}}
      {{- $tuning := get ($root.Values.agent | default dict) "modelTuning" | default dict }}
      {{- if and (get $tuning "document") (not (get $tuning "existingConfigMap")) }}
      checksum/agent-model-tuning: {{ include (print $root.Template.BasePath "/agent-tuning-configmap.yaml") $root | sha256sum }}
      {{- end }}
      {{- with $root.Values.podAnnotations }}
      {{- toYaml . | nindent 6 }}
      {{- end }}
    labels:
      {{- $p.labels | nindent 6 }}
      {{- with $root.Values.podLabels }}
      {{- toYaml . | nindent 6 }}
      {{- end }}
  spec:
    {{- with $root.Values.imagePullSecrets }}
    imagePullSecrets:
      {{- toYaml . | nindent 6 }}
    {{- end }}
    serviceAccountName: {{ include "dbportal.serviceAccountName" $root }}
    securityContext:
      {{- include "dbportal.podSecurityContext" $root | nindent 6 }}
    {{- /* The kubelet does not apply fsGroup to hostPath (and some local) volumes, so a
           statically provisioned PV leaves /app/data unwritable until someone chowns it.
           Opt-in, and only with a real volume: it needs a root container, which the
           restricted-v2 SCC on OpenShift rejects, and an emptyDir gets fsGroup anyway (#170). */}}
    {{- if and (eq $p.dataVolume "shared") (include "dbportal.persistenceEnabled" $root) $root.Values.persistence.fixPermissions }}
    initContainers:
      - name: fix-data-permissions
        image: {{ include "dbportal.image" $root }}
        imagePullPolicy: {{ $root.Values.image.pullPolicy }}
        command:
          - sh
          - -c
          - chown -R {{ $root.Values.podSecurityContext.runAsUser }}:{{ $root.Values.podSecurityContext.fsGroup }} /app/data
        securityContext:
          runAsUser: 0
          runAsNonRoot: false
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop:
              - ALL
            add:
              - CHOWN
              - FOWNER
              - DAC_OVERRIDE
        volumeMounts:
          - name: data
            mountPath: /app/data
        {{- with $root.Values.resources }}
        resources:
          {{- toYaml . | nindent 10 }}
        {{- end }}
    {{- end }}
    containers:
      - name: {{ $root.Chart.Name }}
        securityContext:
          {{- toYaml $root.Values.securityContext | nindent 10 }}
        image: {{ include "dbportal.image" $root }}
        imagePullPolicy: {{ $root.Values.image.pullPolicy }}
        ports:
          - name: http
            containerPort: {{ $root.Values.service.targetPort }}
            protocol: TCP
        envFrom:
          - configMapRef:
              name: {{ include "dbportal.configMapName" $root }}
          {{- with $root.Values.extraEnvFrom }}
          {{- toYaml . | nindent 10 }}
          {{- end }}
        env:
          {{- if or $root.Values.secrets.jwtSecret $root.Values.secrets.existingSecret }}
          - name: JWT_SECRET
            valueFrom:
              secretKeyRef:
                name: {{ include "dbportal.secretName" $root }}
                key: {{ $root.Values.secrets.existingSecretKeys.jwtSecret }}
                {{- if not (include "dbportal.authStrict" $root) }}
                optional: true
                {{- end }}
          {{- end }}
          {{- if or $root.Values.secrets.adminEmail $root.Values.secrets.existingSecret }}
          - name: ADMIN_EMAIL
            valueFrom:
              secretKeyRef:
                name: {{ include "dbportal.secretName" $root }}
                key: {{ $root.Values.secrets.existingSecretKeys.adminEmail }}
                optional: true
          {{- end }}
          {{- if or $root.Values.secrets.adminPassword $root.Values.secrets.existingSecret }}
          - name: ADMIN_PASSWORD
            valueFrom:
              secretKeyRef:
                name: {{ include "dbportal.secretName" $root }}
                key: {{ $root.Values.secrets.existingSecretKeys.adminPassword }}
                {{- /* A hard ref only where a missing password really is an error: strict
                       mode AND the local provider. Under OIDC the app never reads it, so an
                       existingSecret built for OIDC must not keep the pod from starting (#170). */}}
                {{- if not (and (include "dbportal.authStrict" $root) (include "dbportal.localAuth" $root)) }}
                optional: true
                {{- end }}
          {{- end }}
          {{- if or $root.Values.secrets.userPassword $root.Values.secrets.existingSecret }}
          - name: USER_EMAIL
            valueFrom:
              secretKeyRef:
                name: {{ include "dbportal.secretName" $root }}
                key: {{ $root.Values.secrets.existingSecretKeys.userEmail }}
                optional: true
          - name: USER_PASSWORD
            valueFrom:
              secretKeyRef:
                name: {{ include "dbportal.secretName" $root }}
                key: {{ $root.Values.secrets.existingSecretKeys.userPassword }}
                optional: true
          {{- end }}
          {{- /* TOTP second factor. Always optional: MFA is opt-in per account, so a missing
                 key must never keep the pod from starting, and the app treats an absent value
                 as "no second factor". Keyed separately from the passwords rather than nested
                 under them so an operator can rotate a secret without touching a credential. */}}
          {{- if or $root.Values.secrets.adminTotpSecret $root.Values.secrets.existingSecret }}
          - name: ADMIN_TOTP_SECRET
            valueFrom:
              secretKeyRef:
                name: {{ include "dbportal.secretName" $root }}
                key: {{ $root.Values.secrets.existingSecretKeys.adminTotpSecret }}
                optional: true
          {{- end }}
          {{- if or $root.Values.secrets.userTotpSecret $root.Values.secrets.existingSecret }}
          - name: USER_TOTP_SECRET
            valueFrom:
              secretKeyRef:
                name: {{ include "dbportal.secretName" $root }}
                key: {{ $root.Values.secrets.existingSecretKeys.userTotpSecret }}
                optional: true
          {{- end }}
          {{- if or $root.Values.secrets.llmApiKey $root.Values.secrets.existingSecret }}
          - name: LLM_API_KEY
            valueFrom:
              secretKeyRef:
                name: {{ include "dbportal.secretName" $root }}
                key: {{ $root.Values.secrets.existingSecretKeys.llmApiKey }}
                optional: true
          {{- end }}
          {{- if or $root.Values.secrets.oidcClientId $root.Values.secrets.existingSecret }}
          - name: OIDC_CLIENT_ID
            valueFrom:
              secretKeyRef:
                name: {{ include "dbportal.secretName" $root }}
                key: {{ $root.Values.secrets.existingSecretKeys.oidcClientId }}
                optional: true
          {{- end }}
          {{- if or $root.Values.secrets.oidcClientSecret $root.Values.secrets.existingSecret }}
          - name: OIDC_CLIENT_SECRET
            valueFrom:
              secretKeyRef:
                name: {{ include "dbportal.secretName" $root }}
                key: {{ $root.Values.secrets.existingSecretKeys.oidcClientSecret }}
                optional: true
          {{- end }}
          {{- if $root.Values.postgresql.enabled }}
          - name: POSTGRES_PASSWORD
            valueFrom:
              secretKeyRef:
                name: {{ include "dbportal.postgresql.fullname" $root }}
                key: password
          - name: STORAGE_POSTGRES_URL
            value: {{ include "dbportal.postgresql.url" $root | quote }}
          {{- else if or $root.Values.secrets.storagePostgresUrl $root.Values.secrets.existingSecret }}
          - name: STORAGE_POSTGRES_URL
            valueFrom:
              secretKeyRef:
                name: {{ include "dbportal.secretName" $root }}
                key: {{ $root.Values.secrets.existingSecretKeys.storagePostgresUrl }}
                optional: true
          {{- end }}
          {{- if $root.Values.seedConnections.enabled }}
          - name: SEED_CONFIG_PATH
            value: "/app/config/{{ $root.Values.seedConnections.configMapKey | default "seed-connections.yaml" }}"
          - name: SEED_CACHE_TTL_MS
            value: {{ $root.Values.seedConnections.cacheTTL | default 60000 | quote }}
          {{- end }}
          {{- /* Only when the operator said something. Unset writes nothing, so the app
                 derives availability from the AI configuration and the ledger (#331 T5);
                 quoted because EnvVar.value is a string and an unquoted `true` is rejected
                 by the API server. Written before extraEnv so an extraEnv entry of the same
                 name still wins. */}}
          {{- if include "dbportal.agentFlagSet" $root }}
          - name: DBPORTAL_AGENT_ENABLED
            value: {{ get $root.Values.agent "enabled" | quote }}
          {{- end }}
          {{- /* The conversation off-switch, on the same rule as the flag above: unset
                 writes nothing and the app keeps its own default, which is on. Quoted for
                 the same reason, and written before extraEnv for the same reason. */}}
          {{- if not (kindIs "invalid" (get $root.Values.agent "threadContext")) }}
          - name: DBPORTAL_AGENT_THREAD_CONTEXT
            value: {{ get $root.Values.agent "threadContext" | quote }}
          {{- end }}
          {{- /* Where the mounted tuning document lands. Its own directory rather than
                 /app/config, which the seed ConfigMap already claims: a second volume at
                 the same mountPath would hide the first. Written before extraEnv so an
                 extraEnv entry of the same name still wins, like the flag above. */}}
          {{- if include "dbportal.agentTuningSet" $root }}
          - name: AGENT_MODEL_TUNING_PATH
            value: "/app/model-tuning/{{ include "dbportal.agentTuningKey" $root }}"
          {{- end }}
          {{- /* The agent's ledger directory, set by the chart because the image a
                 default install pulls does not yet set it. image.tag defaults to
                 .Chart.AppVersion, and the Dockerfile's own
                 WORKFLOW_LOCAL_DATA_DIR default landed after that version was
                 tagged - so on the image this chart actually deploys today the
                 ledger would resolve to `.workflow-data` under WORKDIR /app, which
                 securityContext.readOnlyRootFilesystem makes unwritable, and every
                 run would refuse with LEDGER_UNAVAILABLE. /app/data is mounted in
                 every render (emptyDir, or the PVC when persistence is enabled).
                 Once an image carrying the ENV is released the two agree on the
                 same path, so this stays correct rather than becoming redundant.
                 Written before extraEnv, so an operator can still move it. */}}
          - name: WORKFLOW_LOCAL_DATA_DIR
            value: /app/data/workflow
          {{- /* The deployment's role (docs/CONTEXT.md §4.30). Written only for the agent
                 role, so a studio render stays byte-for-byte what it was; before extraEnv
                 so an operator can still override it. */}}
          {{- if ne $p.role "studio" }}
          - name: DBPORTAL_ROLE
            value: {{ $p.role }}
          {{- end }}
          {{- /* A studio with a workers Deployment beside it (§4.40) only enqueues, unless the
                 operator said otherwise in config.jobsWorker, which the ConfigMap carries. */}}
          {{- if and (eq $p.role "studio") $root.Values.workers.enabled (not $root.Values.config.jobsWorker) }}
          - name: JOBS_WORKER
            value: "off"
          {{- end }}
          {{- with $root.Values.extraEnv }}
          {{- toYaml . | nindent 10 }}
          {{- end }}
        {{- with $root.Values.startupProbe }}
        startupProbe:
          {{- include "dbportal.probe" (dict "probe" . "basePath" ($root.Values.config.basePath | default "")) | nindent 10 }}
        {{- end }}
        {{- with $root.Values.readinessProbe }}
        readinessProbe:
          {{- include "dbportal.probe" (dict "probe" . "basePath" ($root.Values.config.basePath | default "")) | nindent 10 }}
        {{- end }}
        {{- with $root.Values.livenessProbe }}
        livenessProbe:
          {{- include "dbportal.probe" (dict "probe" . "basePath" ($root.Values.config.basePath | default "")) | nindent 10 }}
        {{- end }}
        resources:
          {{- toYaml $p.resources | nindent 10 }}
        volumeMounts:
          - name: next-cache
            mountPath: /app/.next/cache
          - name: tmp
            mountPath: /tmp
          - name: data
            mountPath: /app/data
          {{- if $root.Values.seedConnections.enabled }}
          - name: seed-config
            mountPath: /app/config
            readOnly: true
          {{- end }}
          {{- if include "dbportal.agentTuningSet" $root }}
          - name: agent-model-tuning
            mountPath: /app/model-tuning
            readOnly: true
          {{- end }}
    volumes:
      - name: next-cache
        emptyDir: {}
      - name: tmp
        emptyDir: {}
      {{- if and (eq $p.dataVolume "shared") (include "dbportal.persistenceEnabled" $root) }}
      - name: data
        persistentVolumeClaim:
          claimName: {{ include "dbportal.pvcName" $root }}
      {{- else }}
      - name: data
        {{- /* /app/data is the one volume a user can grow (SQLite storage, seeded samples),
               so it is the one worth capping. Empty stays uncapped: a retroactive limit
               would start evicting pods that are fine today (#170). */}}
        {{- if $root.Values.persistence.emptyDirSizeLimit }}
        emptyDir:
          sizeLimit: {{ $root.Values.persistence.emptyDirSizeLimit | quote }}
        {{- else }}
        emptyDir: {}
        {{- end }}
      {{- end }}
      {{- if $root.Values.seedConnections.enabled }}
      - name: seed-config
        configMap:
          name: {{ $root.Values.seedConnections.existingConfigMap | default (printf "%s-seed-connections" (include "dbportal.fullname" $root)) }}
      {{- end }}
      {{- if include "dbportal.agentTuningSet" $root }}
      - name: agent-model-tuning
        configMap:
          name: {{ get (get $root.Values.agent "modelTuning") "existingConfigMap" | default (printf "%s-agent-model-tuning" (include "dbportal.fullname" $root)) }}
      {{- end }}
    {{- with $root.Values.nodeSelector }}
    nodeSelector:
      {{- toYaml . | nindent 6 }}
    {{- end }}
    {{- with $root.Values.affinity }}
    affinity:
      {{- toYaml . | nindent 6 }}
    {{- end }}
    {{- with $root.Values.tolerations }}
    tolerations:
      {{- toYaml . | nindent 6 }}
    {{- end }}
    {{- with $root.Values.topologySpreadConstraints }}
    topologySpreadConstraints:
      {{- toYaml . | nindent 6 }}
    {{- end }}
{{- end }}
