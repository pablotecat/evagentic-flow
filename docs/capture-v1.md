# Contrato de captura local v1

## Mecanismo físico elegido para #2

Esta implementación elige **un diario JSONL UTF-8 por activación del plugin**,
con nombre UUID y creación exclusiva, dentro del destino configurable. Es una
decisión de este corte, no una aprobación retroactiva de propuestas anteriores.
Frente al almacén privado de OpenCode, permite consultar evidencia sin runtime,
funciones privadas ni una web adicional; frente a snapshots separados, evita
duplicar contenido y coordinar varios archivos para este caso simple.

La preparación escribe primero un archivo `.pending` y solo lo renombra a
`.jsonl` tras confirmar la escritura y comprobar que la suscripción no haya
fallado durante ella. Un `.pending` conservado indica preparación incompleta;
el lector lo señala con error, sin presentarlo como evidencia preparada.

Cada línea termina en LF; cada escritura se serializa y se confirma con `fsync`.
Se abre y cierra el archivo por escritura, sin recrear un diario desaparecido;
así se detecta también la pérdida del destino en Windows, sin mantener un handle
que impida mover la evidencia para diagnosticarla.
Esto añade latencia al observador y no demuestra entrega exactamente una vez ni
supervivencia a cualquier fallo de hardware. La finalización del cliente no
cierra el registrador de servidor. No hay borrado, rotación ni subida automáticos.
Los archivos se crean con modo `0600` y el directorio nuevo con `0700` donde el
sistema lo soporta; en Windows deben revisarse las ACL del destino. No hay cifrado.

## Sobre común

Cada fila es un objeto JSON con estos campos obligatorios:

| Campo | Tipo / significado |
| --- | --- |
| `schemaVersion` | Número `1`; versión del contrato de captura, no del evento de OpenCode. |
| `captureID` | UUID del diario/activación; **no** un identificador de ejecución. |
| `arrival` | Entero creciente desde `1`, local al diario; orden de escritura/observación, no causalidad. |
| `observedAt` | Milisegundos Unix del reloj local al registrar. |
| `type` | `recorder.ready`, `recorder.failed`, `recorder.gap`, `recorder.tools.available` o tipo público `session.*`, `permission.*` o `form.*` admitido. |

Versiones desconocidas requieren otro lector; no reinterpretarlas como v1.
Una línea truncada o JSON inválido es evidencia incompleta, nunca una fila válida
ni una razón para descartar el resto silenciosamente. El lector incluido falla
de forma visible; conservar el original antes de cualquier reparación manual.

## Preparación y diagnósticos

`recorder.ready` añade `runtimeVersion`, `sdkVersion` y `coverage` (objeto con
`replay: false`, las categorías `content` y `excluded`, `executionID: "not-exposed"`
y `ordering: "arrival-is-not-causality"`). Registra la comprobación de versión
exacta `2.1.2`, capacidades públicas necesarias y escritura durable, **no** salud
perpetua ni cobertura completa. No confundir `@opencode/plugin` con los SDK V1
`@opencode-ai/plugin` / `@opencode-ai/sdk`.

Un fallo de preparación no constituye preparación satisfactoria. Si la propia confirmación de disco falla, cualquier
archivo `.pending` creado debe considerarse incompleto aunque contenga una fila
`recorder.ready`; el aviso público de fallo prevalece. No usar solo la presencia
de un archivo ni el estado `active` del cargador para decidir que se puede trabajar.

`recorder.failed` añade `reason: "event-stream-or-persistence-failure"`. Es un
diagnóstico del registrador, **no** un hecho del flujo ni una causa del fallo del
agente. Puede no escribirse si el disco falla; también se avisa en stderr del
servidor. No hay recuperación automática ni replay. Tras un fallo de escritura,
la cola no se recupera para escribir diagnósticos como si la captura siguiera sana.

### Aviso e interrupción (#3 y #4)

Se usa el título existente de la sesión y su metadata pública, no un toast efímero
ni una suscripción del navegador. `GET /api/session/{sessionID}` devuelve en
`data.metadata.evagenticRecorder`:

| Campo | Significado |
| --- | --- |
| `status` | `failed`: el guardián puede estar activo aunque la captura no lo esté. |
| `reason` | `preparation-failure` o `event-stream-or-persistence-failure`. |
| `notice` | Aviso fijo: revisar antes de volver a ejecutar; sin rutas, payloads ni errores originales. |
| `reviewRequired` | `true`; no hay recuperación automática. |
| `pilotReady` | `false`; esta entrega no autoriza el piloto. |
| `interruption.requested` | Si se ha iniciado la solicitud para esta sesión. Un encargo nuevo bloqueado puede llevar `false`. |
| `interruption.result` | `pending`, `accepted` (la API devolvió `interrupted: true`), `not-running`, `failed` o `not-requested`. |
| `interruption.stop` | `confirmed` solo tras `wait`, desenlace `interrupted` y `time.idle` posterior a la solicitud; en otro caso `unconfirmed`. |

Aviso, solicitud, respuesta de la API y confirmación son hechos distintos. La
solicitud usa `resume: false`; las llamadas de aviso, interrupción y confirmación
tienen plazo acotado. Una confirmación fallida no transforma una solicitud aceptada
en parada confirmada. Stderr declara también el resultado y las limitaciones si
la interfaz pública o el almacenamiento del plugin fallan.

La marca `failure` en el almacenamiento del plugin, independiente del directorio
de captura, se arma duraderamente **antes** de emitir `recorder.ready`. Solo una
limpieza sana la retira; un fallo al actualizar el diagnóstico conserva el armado
previo. Por eso un cierre abrupto, aun sin callback de fallo, exige revisión en el
arranque siguiente. Una recarga sana sí puede preparar otro diario. Se conserva la
evidencia ya escrita. No se expone una operación de desbloqueo ni se borra esa
marca por reparar el destino; hace falta revisión antes de volver a ejecutar.

En 2.1.2 se ha comprobado que lanzar un error desde `setup` deja continuar al
runtime. Por eso el registrador conserva activo un hook de admisión que rechaza
encargos cuando falla la preparación. También comprueba el fallo antes del
despacho de modelos (`context`, `title`, `compaction`, `generate`), para cerrar la
carrera con encargos cuya admisión ya estaba en curso. El cargador lo muestra como `active`:
significa **guardián cargado**, no captura preparada. Un hook rechazado devuelve
HTTP 500 sin cuerpo tipado; el aviso permanece en la sesión. Los nuevos encargos
bloqueados también reciben ese aviso. Sin configuración válida no se observa ni
se interrumpe otras sesiones: solo se bloquea la admisión local donde se cargó el
plugin. Con una selección válida ajena, el hook se retira.

Ante pérdida de la ruta o fallo de enumeración, se intenta interrumpir también
las sesiones ya verificadas durante la captura. Esa memoria solo autoriza la
misma identidad de proyecto/sesión y la misma ubicación previamente comprobada;
no autoriza capturar más contenido por una ruta ahora inaccesible ni interrumpir
una sesión que se sabe trasladada fuera del alcance.

Un runtime incompatible o incapaz de registrar el guardián queda públicamente
`failed`, pero **eso no demuestra bloqueo de la ejecución**: impide declarar
preparado el piloto. No se promete cancelar descendientes, herramientas que no
cooperen ni efectos externos, ni parada instantánea o reversión. Este corte
comprueba sesiones simples y árboles con delegación anidada y concurrencia; no
autoriza el piloto ni otros mecanismos de trabajo no ejercitados.
Si ni siquiera se puede armar el estado inicial, no se declara captura preparada;
no hay garantía ficticia de recordar un fallo tras perder todo el almacenamiento
del runtime. Esto bloquea autorizar el piloto, no autoriza recrear la base de
datos para eludir la revisión.

La enumeración del proyecto se repite después de cada oleada de solicitudes hasta
una comprobación sin identidades nuevas. Las sesiones ya verificadas también se
incluyen si falla la enumeración. La suscripción no se cierra por perder el diario:
continúa verificando identidades y solicitando interrupciones de sesiones nuevas,
sin capturar contenido después del fallo. Si se pierde el propio stream, solo
quedan la enumeración y los guardias; no se afirma cobertura en vivo de ese hueco.
Se solicita una interrupción por sesión y activación del guardián, sin duplicarla
por sus propios eventos de aviso. Admisión, despacho de modelos, herramientas y
shell quedan bloqueados localmente. No se borran sesiones para detenerlas.

Cada sesión conserva su diagnóstico público, incluso un descendiente creado
durante la comprobación. `confirmed` se refiere exclusivamente a esa sesión y al
desenlace comprobado, no a todos sus efectos. Una notificación de subagente puede
competir con los guardias y terminar en fallo o sin desenlace `interrupted`:
la solicitud aceptada permanece con parada `unconfirmed`. El SDK fijado no expone
un registro independiente de jobs ni una confirmación de sus efectos externos;
los trabajos de subagente aquí ejercitados se identifican por su sesión hija.

`recorder.gap` añade `reason: "unrecognized-session-envelope"`: un evento de
sesión observable no trae el sobre necesario para atribuirlo. Conserva solo el
diagnóstico de cobertura, nunca su payload, tipo original ni identidades sin
verificar. Una ubicación explícita ajena se excluye antes de este diagnóstico.

## Evidencia de eventos

Además del sobre, todas las filas de eventos públicos admitidos incluyen:

| Campo | Tipo / significado |
| --- | --- |
| `source` | Cadena fija `opencode.event`. |
| `eventID` | ID público del evento, o `null` si no es seguro conservarlo. |
| `sourceTime` | Milisegundos Unix de `event.created`, reloj del servidor. |
| `sourceSequence` | Entero de `event.durable.seq`, o `null` si no existe. |
| `sourceVersion` | Entero de `event.durable.version`, o `null`. |
| `sourceAggregateID` | ID del agregado durable, o `null`. La secuencia solo se compara dentro de ese agregado. |
| `projectID` | ID público de proyecto comprobado en la sesión, o `null` por exclusión de seguridad. |
| `sessionID` | ID público de sesión, o `null` por exclusión de seguridad. |
| `executionID` | `null`: este contrato V2 no expone un ID de ejecución en los eventos usados. |
| `messageID` | `assistantMessageID`, `inboxID` o `messageID` observados, o `null`. No se inventa una asociación. |
| `ordinal` | Entero de bloque de contenido cuando existe, o `null`. |
| `content` | `null` o `{ "role": "user" \| "assistant", "text": "…" }`, ya filtrado. |
| `status` | `captured`, `omitted` o `unrecognized`; `captured` puede referirse a `content`, `tool`, `interaction` o `retry`. |
| `omissions` | Array de códigos de omisión, sin datos originales. |
| `redactions` | Array de códigos de filtrado, sin los valores eliminados. |

El corte #4 añade a las filas nuevas el siguiente grupo de campos. El lector
actual acepta también filas v1 anteriores sin el grupo completo; no las rellena
por inferencia. Todos los identificadores nuevos pasan las mismas exclusiones:

| Campo | Tipo / significado |
| --- | --- |
| `parentSessionID` | Padre leído mediante `session.get`, solo si también está autorizado; `null` si ausente, excluido o desconocido. |
| `agentID` | Agente seleccionado que expone la sesión, o `null`; no se supone `build` si falta. |
| `sessionObservedAt` | Momento local de la lectura de sesión/padre; no fecha causal del evento ni snapshot histórico de su agente. |
| `callID` | `data.id` de un evento `session.tool.*`, o `null`. Identidad compuesta: **sesión + mensaje + llamada**, no nombre del componente. |
| `toolName` | Nombre efectivo expuesto por `session.tool.input.started`, conservado para las fases de esa misma llamada; `null` si no se observó o fue excluido. |
| `childSessionID` | Sesión hija expuesta en `session.tool.success` v2 de una llamada previamente observada como `subagent`, comprobando proyecto, ubicación y padre; en otro caso `null`. |

La procedencia de estas relaciones es el evento público salvo padre y agente,
leídos por la API pública en `sessionObservedAt`. No se conserva metadata
arbitraria de herramientas. Un padre no demuestra qué llamada creó al hijo;
solo el resultado de delegación observado aporta ese enlace. Una llamada sin
resultado conserva su identidad sin inventar un hijo. Los hooks son guardias,
no filas adicionales de invocación: la captura de actividad usa solo eventos.
Varias fases con la misma identidad compuesta son observaciones de la misma
llamada, no ejecuciones nuevas. Esto no garantiza exactamente una vez entre
persistencia y efectos externos.

`inspect.mjs <directorio> <sesión> --tree` selecciona raíz y descendientes conocidos,
manteniendo el orden local de cada diario. Los inicios y desenlaces de ejecución
conservan `sourceTime` y secuencia dentro de su agregado. Sus intervalos permiten
distinguir ramas solapadas; no hay suma de duraciones ni orden causal global.
El ID causal de ejecución sigue sin exponerse: `executionID` permanece `null`,
también cuando un aviso de subagente inicia otra ronda en la misma sesión.

El campo `content` solo conserva texto de `session.inbox.enqueued` con item `user` (encargo ya
admitido, versión durable `1`) y `session.text.ended` (bloque final de respuesta,
versión durable `1`). Un encargo admitido con `resume: false` **no** demuestra
ejecución. Un bloque final no demuestra por sí solo éxito global del encargo.
Los eventos `session.execution.*` conservan sus identidades/tiempos como
metadatos; su ID de evento identifica ese hecho, no se reutiliza como ID causal
de otros eventos. No se asocian respuestas al último encargo por orden de llegada.

Salvo los formatos de #5 descritos a continuación, los demás eventos de sesión observables conservan sobre y metadatos permitidos,
pero **no payload** (`status: omitted`, `event-payload-not-captured`). Los campos
no textuales del encargo/respuesta quedan excluidos (`non-text-fields-not-captured`).
Un texto reconocido con forma o versión no admitida queda sin contenido y con
`status: unrecognized`, `unrecognized-content-format`. Un tipo/forma de item de
inbox desconocido lleva `unrecognized-inbox-format`. Los identificadores con
formato no permitido o con secretos configurados se sustituyen por `null` y se
señalan con `unsafe-identifier`. Nunca se conserva un payload desconocido como
fallback. No se afirma que el SDK entregue eventos que él mismo no reconoce.

## Herramientas, intentos e interacciones (#5)

Se añaden `tool`, `interaction` y `retry`, objetos o `null`, a las nuevas filas de
eventos. El lector admite filas v1 anteriores sin esos campos; no las completa
por inferencia. `recorder.ready.coverage.content` declara las categorías nuevas.
`executionID` sigue en `null`: ni el orden de llegada ni el último encargo permiten
inventar el ID causal de ejecución que no expone este runtime.

### Llamadas e inventario

Cada **intento de herramienta** se identifica por proyecto + sesión + mensaje de
asistente + llamada. `input.started`, `input.ended`, `called` y el desenlace son
fases de ese intento, no llamadas adicionales. Se usa cualquier nombre efectivo
observado, no una lista de nombres heredados. Los tiempos disponibles son los
`sourceTime` de cada fase; `observedAt` no se presenta como inicio de ejecución.

Los eventos `session.tool.input.started`, `session.tool.input.ended` y
`session.tool.called` v1, y `session.tool.success` / `session.tool.failed` v2,
conservan en `tool`:

| Campo | Significado |
| --- | --- |
| `input` | Argumentos JSON filtrados de `called`, o `null` si no disponibles. |
| `inputText` | Entrada completa filtrada de `input.ended`, o `null`; nunca deltas. JSON válido se decodifica y normaliza antes de filtrar (incluidos secretos escapados); no conserva bytes ni claves duplicadas. Texto no JSON usa el filtrado textual y puede quedar sintácticamente incompleto. |
| `output` | Partes `{type: "text", text: "…"}` filtradas del resultado o progreso parcial terminal; `null` si no observadas. |
| `error` | Solo `type`, `message` y, si existe, `status` HTTP válido del error terminal; no cuerpo de respuesta, stack ni error original. |
| `outcome` | `not-observed` antes de un desenlace reconocido; `success` o `error` en el desenlace. No es aceptación global. |
| `executed` | Booleano público, sin reinterpretarlo: en las herramientas locales ejercitadas fue `false` incluso con resultado observado. `null` si no existe. |
| `reportedError` | Únicamente el booleano `metadata.error` cuando existe. Code Mode puede emitir `success` con este valor `true`; entonces `outcome` es `error`, conservando el tipo de evento original. |
| `retryOf`, `operationID` | `null`: este contrato no expone esos enlaces para herramientas. No se agrupan llamadas por nombre, argumentos ni proximidad. |
| `consumption` | `null`: desconocido, no cero. Una llamada no acredita una petición HTTP ni visibilidad de sus servicios internos. |

Las partes `file` no conservan URI, MIME, nombre ni bytes; se señala
`tool-file-content-not-captured`. Una forma o versión no admitida queda sin `tool`,
con `unrecognized-tool-format`. Los deltas y progreso efímero quedan omitidos;
`native` y metadata arbitraria tampoco se conservan. Un error registrado de una
herramienta no activa la política de fallo del registrador.

`recorder.tools.available` es un snapshot de lectura, **no una invocación**:
`source: "opencode.tool.list"`, `projectID`, `sessionID`, `toolNames` registrados,
`modelToolNames` vistos en el hook `context` y `omissions`. No copia descripciones,
esquemas ni ejecutores. Los nombres excluidos se señalan con `unsafe-identifier`.
Es disponibilidad en ese punto del hook, no garantía de selección final tras
hooks posteriores, de permisos concedidos ni de herramientas realmente usadas.

`session.retry.scheduled` v1 conserva `retry: {kind: "model", attempt, at, error}`:
número y próximo tiempo declarados por el runtime, mensaje asociado y error filtrado
con el mismo esquema anterior. No son intentos de herramienta ni una medición de
tráfico HTTP. En la prueba se necesitaron tres respuestas 429 para que el runtime
expusiera el reintento de sesión: el primer 429 pudo recuperarse internamente sin
ese evento. No se inventan las llamadas internas no observadas. Las formas no
admitidas se marcan `unrecognized-retry-format`; el cuerpo del error se excluye.

### Diagnóstico independiente de intentos

`inspect.mjs <directorio> <sesión> --tools` emite JSONL de diagnóstico, sin
modificar el diario ni ejecutar OpenCode. Cada fila `diagnostic.tool-attempt` tiene
`diagnosticVersion: 1`, identidad compuesta, nombre, argumentos/texto y
resultado/error filtrados, `startedAt`, `calledAt`, `endedAt`, `outcome`, relaciones
y consumo desconocidos, `evidence`, `horizons`, `omissions` e `incident`.
`evidence` referencia `captureID`, `arrival`, `eventID` y tipo de las fases;
`horizons` identifica la última fila leída de cada diario. Los tiempos ausentes
quedan en `null`. No se mezclan identidades incompletas por exclusión de seguridad.
`omissions` conserva sin duplicar las omisiones de todas las fases del intento,
también las de payloads no reconocidos y resultados de archivo sin texto capturado.

Un fallo conserva `incident: {kind: "tool-error", cause: null}` y su error
observado aunque un intento posterior termine bien. No se deduce la causa raíz
del mero mensaje de error. Sin desenlace reconocido, el incidente es
`{kind: "outcome-not-observed", cause: null}`: describe el límite de evidencia
leída, no prueba timeout, interrupción de herramienta, fallo ni consumo cero.
Puede ser trabajo todavía en curso. Una fila terminal con payload no reconocido
tampoco acredita éxito. Los diagnósticos se pueden guardar por redirección en
una ubicación local fuera de Git; siguen separados de captura y evaluación.

### Solicitudes y decisiones externas

Se admiten `permission.asked`, `permission.replied`, `form.created`, `form.replied`
y `form.cancelled` del stream público de 2.1.2. Son eventos efímeros sin versión
durable; se comprueba proyecto y ubicación de su sesión igual que para `session.*`.
`form.created` atribuye la sesión desde `data.form.sessionID`. Se excluye el dueño
`global` de formularios de autenticación/MCP, que no es una sesión del proyecto.

`interaction` contiene:

| Campo | Significado |
| --- | --- |
| `kind`, `requestID`, `phase` | `permission` o `form`, ID seguro de solicitud, fase `requested`, `replied` o `cancelled`. |
| `origin` | `runtime-request`, `external-reply-unattributed` o `runtime-cancellation`. No identifica persona ni atribuye respuestas al agente. |
| `request` | Aprobación: `action`, `resources`, `save` y `message` disponibles. Formulario: título y campos permitidos. Siempre filtrados. |
| `response` | Aprobación: `{decision: "once" \| "always" \| "reject"}`. Formulario: respuestas a campos autorizados de una solicitud observada. `null` si ausentes o no autorizadas. |
| `relationSource` | `permission-source` / `form-question-metadata` en solicitudes con enlace expuesto; `permission-request-event` / `form-request-event` para respuestas vinculadas a aquella solicitud; `null` sin evidencia. |

Los enlaces rellenan `callID` y `messageID` únicamente desde `Permission.Source`
de tipo `tool`, o `form.metadata` con `kind: "question"` y `tool.id/messageID`
observados en la pregunta nativa. Se conserva su procedencia, no metadata
arbitraria ni una garantía independiente de autenticidad del cliente que creó
la solicitud. Una respuesta sin solicitud observada no hereda enlaces por orden.
El actor que llamó a la API no se expone: una decisión destinada a una persona
no demuestra que la tomara una persona autenticada ni un agente concreto.

Los formularios admiten campos `string`, `number`, `integer`, `boolean` y
`multiselect`; conservan clave, tipo, título, descripción, opciones, condición,
obligatoriedad y selección personalizada disponibles. Se excluyen campos ocultos
y sus respuestas; también defaults y otras restricciones. Los formatos no
admitidos (por ejemplo `external`) quedan sin contenido con
`unrecognized-interaction-format`, sin volcar el formato desconocido.
Las respuestas sin solicitud reconocida no guardan valores; se señala
`form-request-not-observed-or-unrecognized`. Las claves no autorizadas se omiten
con `form-answer-fields-not-authorized`. No se captura metadata arbitraria.

Se señalan además actor no expuesto, enlace de llamada no observado y mensajes
de réplica de permiso/cancelación no expuestos cuando corresponde. No se consulta
estado privado ni se reconstruye contenido ausente mediante historial o replay.

## Alcance y cobertura real

La instancia del plugin solo escribe si su ubicación coincide con el directorio
autorizado resuelto mediante `realpath`. Cada evento se filtra de nuevo por su
ubicación cuando existe y por el ID de proyecto y ubicación públicos de su sesión.
No se asume que el stream sea local al plugin. Los eventos de otro proyecto no
se registran, ni siquiera sus IDs. Si no se puede comprobar una sesión, la captura
falla visiblemente en vez de atribuirle contenido por inferencia.

El stream es **en vivo**: no se recupera lo anterior al arranque y puede faltar
`session.created` cuando la carga del plugin se difiere hasta el primer prompt.
No se capturan eventos globales, texto de deltas, razonamiento, contenido no admitido de herramientas,
adjuntos, instrucciones, definiciones, skills ni entregables en este corte.
Si una respuesta se interrumpe antes del bloque final, no se recupera su texto
parcial. Las pruebas sintéticas ejercitan subejecuciones anidadas, llamadas
repetidas al mismo agente y ramas concurrentes, incluida su interrupción y el
aislamiento de otro proyecto. No demuestran cancelación de efectos externos,
cobertura completa de sesiones movidas ni de otros tipos de trabajo.

## Exclusión de secretos

Los valores literales de `secrets` se reemplazan por `[REDACTED]` antes de escribir
texto (`configured-literal`). También se filtran patrones reconocibles de
Bearer/Basic, asignaciones de autorización/cookies/claves/tokens/contraseñas y bloques PEM privados
(`credential-pattern`). Se trabaja sobre el bloque completo, no sobre fragmentos
que podrían dividir una credencial. Cookie y Set-Cookie se filtran hasta el final
de la línea, incluidas continuaciones indentadas: no se conservan cookies posteriores
ni atributos separados por espacios, comas o punto y coma. Solo entran campos explícitamente permitidos;
no se serializan metadata arbitraria, cabeceras de transporte, configuración global ni errores
con contenido original. En JSON se filtran también claves sensibles anidadas
(incluidas autorización y cookies) antes de persistir argumentos o decisiones.
Solo se admiten valores JSON finitos, de objetos ordinarios y profundidad máxima
32; formatos no admitidos se señalan sin serializarlos como fallback.
No se promete detectar cualquier secreto en texto libre,
codificado u ofuscado. Revisar la configuración local antes de activar cada caso.

No se copian las rutas de configuración al diario. El contenido de trabajo
autorizado (por ejemplo argumentos de una herramienta) puede contener rutas;
no es anonimización. Tanto capturas como configuración local quedan fuera de
control de versiones y no se publican automáticamente. Los ejemplos versionados
solo usan rutas y datos sintéticos.

Referencias públicas comprobadas: [plugins de servidor V2](https://opencode.ai/v2/docs/build/plugins/server),
[API V2](https://opencode.ai/v2/docs/api), [cliente V2](https://opencode.ai/v2/docs/build/client).
