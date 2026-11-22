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
| `type` | `recorder.ready`, `recorder.failed`, `recorder.gap`, `recorder.tools.available`, `recorder.observation` o tipo público `session.*`, `permission.*` o `form.*` admitido. |

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

Desde #6, `recorder.ready` añade `observationVersion: 1`, `recorderVersion` y
`versionSources`. El servidor procede de `ctx.app.version`; `sdkVersion` es la
versión del manifiesto resuelto de **la dependencia del registrador**, y
`recorderVersion` la de su propio manifiesto instalado. Las fuentes se declaran
como `runtime: "ctx.app.version"`, `sdk: "resolved-package-manifest"` y
`recorder: "recorder-package-manifest"`. Si un manifiesto no puede comprobarse,
su versión es `null` y su fuente `unknown`, nunca una constante supuesta.
`hostSdk: null` declara desconocida la versión del SDK interno del servidor;
no se iguala a la dependencia del registrador. Son versiones de paquete, no una
atestación de sus bytes ni un SHA del repositorio de desarrollo. El lector sigue
admitiendo las filas v1 anteriores sin este grupo de campos.

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
| `status` | `captured`, `omitted` o `unrecognized`; `captured` puede referirse a `content`, `tool`, `interaction`, `retry`, `skill`, `measurement` o `lifecycle`. |
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

La selección normal y de árbol incluye como diagnósticos globales únicamente
`recorder.ready`, `recorder.failed` y `recorder.gap`. Una observación o inventario
con `sessionID: null` conserva una relación desconocida o excluida, no una relación
global: no se atribuye a la sesión seleccionada. Sigue visible al leer sin filtro.

El campo `content` solo conserva texto de `session.inbox.enqueued` con item `user` (encargo ya
admitido, versión durable `1`) y `session.text.ended` (bloque final de respuesta,
versión durable `1`). Un encargo admitido con `resume: false` **no** demuestra
ejecución. Un bloque final no demuestra por sí solo éxito global del encargo.
Los eventos `session.execution.*` conservan sus identidades/tiempos como
metadatos; su ID de evento identifica ese hecho, no se reutiliza como ID causal
de otros eventos. No se asocian respuestas al último encargo por orden de llegada.

Salvo los formatos de #5, #6 y #7 descritos a continuación, los demás eventos de sesión observables conservan sobre y metadatos permitidos,
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

## Skills, definiciones e instrucciones observadas (#6)

La captura separa **disponibilidad**, **admisión**, **carga/activación**,
**definición del registro**, **archivo desplegado** y **contexto en un hook**.
No se suman esas observaciones como invocaciones diferentes, ni se deriva de
ellas cumplimiento, ciclo de vida, duración o coste por skill.

### Carga y activación

Las nuevas filas de eventos añaden `skill`, objeto o `null` (el lector admite
filas anteriores sin él). Contiene `id`, `name`, `text`, `sha256`, `origin`,
`contextID: null` y `consumption: null`:

- Un `session.tool.success` v2, con resultado reconocido y no marcado como error,
  de una llamada identificada públicamente como `skill`, conserva el ID de su
  argumento `id` y el texto filtrado del resultado. `origin` es
  `successful-skill-tool-result`; `name` queda `null`. Conserva sesión, mensaje y
  llamada de ese intento, incluidos los eventos internos públicos de Code Mode.
- `session.skill.activated` v1 conserva `id`, `name` y `text` del propio evento,
  con `origin: "runtime-activation-event"`. Este evento no expone mensaje,
  llamada ni ID causal de ejecución/contexto: no se rellenan por proximidad.
- `sha256` es SHA-256 del **texto filtrado** en UTF-8; no del original secreto.
  El lector comprueba su correspondencia. Formas/versiones no admitidas quedan
  sin skill y con `unrecognized-skill-format`; las cargas fallidas no acreditan
  activación. Los IDs excluidos quedan `null` con `unsafe-identifier`.

Las skills adjuntas a un encargo se registran por separado desde el payload
`skills` de `session.inbox.enqueued` v1. Es una **admisión**, incluso con
`resume: false`, no prueba de despacho ni consumo por el modelo. Conserva el
mensaje/evento admitido, nombre, ID y texto resuelto, no una lectura retrospectiva
del archivo. Una forma desconocida produce `unrecognized-admitted-skill-format`.
Los enlaces de ejecución y contexto no expuestos permanecen `null`; los códigos
`skill-*-context-link-not-exposed` y `skill-consumption-not-exposed` lo explicitan.

### Observaciones versionadas

`recorder.observation` no es una invocación ni un evento inventado del runtime.
Además del sobre común lleva:

| Campo | Significado |
| --- | --- |
| `observationVersion` | `1`, contrato de observaciones dentro de captura v1. El lector rechaza versiones desconocidas. |
| `stage`, `source`, `identity` | Etapa de la tabla siguiente, fuente pública/lectura de archivo e identidad de la definición/punto; `null` cuando no existe. |
| `observationTime` | Momento local de la observación, distinto de la fecha del evento relacionado y de su escritura (`observedAt`). |
| `requestObservationID` | UUID local que agrupa el hook y sus lecturas asociadas; **no** identifica un despacho, intento ni ejecución del runtime. |
| `projectID`, `sessionID` | Alcance comprobado; identificadores inseguros quedan `null`. |
| `executionID` | Siempre `null`, no expuesto. |
| `messageID`, `eventID` | Solo los enlaces públicos disponibles; `null` en lecturas de hook sin esos enlaces. |
| `value` | Contenido permitido y filtrado; formas admitidas en la tabla. |
| `sha256`, `hashBasis` | SHA-256 de `JSON.stringify(value)` en UTF-8, con `hashBasis: "redacted-json-utf8"`. Incluye la proyección capturada, no el objeto/archivo original. |
| `status`, `omissions`, `redactions` | `captured` o `unrecognized`, límites y códigos de filtrado. Una proyección no serializable queda con `value`/hash `null`, `unrecognized-observation-format`, sin fallback crudo. |

El hash permite verificar la versión **conservada** sin volver a resolver una
ruta mutable; no ofrece firma, autenticidad ni integridad frente a quien cambie
contenido y hash juntos. Las redacciones pueden hacer indistinguibles versiones
que solo difieren en secretos. El lector comprueba los hashes antes de imprimir
la fila; no necesita OpenCode ni acceso al proyecto.

| `stage` / `source` | `value` y alcance |
| --- | --- |
| `availability` / `opencode.skill.list` | Array de `{id, name, description, autoinvoke}` en cada hook. No copia el contenido de skills no usadas ni prueba permisos, selección o activación. |
| `admitted-skill` / `opencode.session.inbox.skills` | `{id, name, text}` resueltos en la admisión, con sus enlaces de mensaje/evento. |
| `runtime-definition` / `opencode.skill.list` | `{id, name, description, content, path, autoinvoke}` de la skill cargada/admitida, leída **después** del hecho. Es el registro transformado actual, no garantía de snapshot histórico de esa activación. |
| `deployed-file` / `node.fs.readFile` | `{path, content}` del archivo apuntado por esa skill, solo si `realpath` queda dentro del proyecto autorizado y es regular. Ruta relativa y contenido UTF-8 filtrado; no se busca el repositorio de desarrollo. |
| `runtime-definition` / `opencode.agent.get` | `{id, name, mode, description, system}` del agente del hook, leído en ese momento y ligado por `requestObservationID`. No copia settings, permisos ni configuración global. |
| `context-hook` / `opencode.session.hook.<nombre>` | Proyección de la petición en el punto del registrador: `kind`, `agentID`, `model: {providerID, id}`, `system`, `messages`, `tools`, `finalContext: false`. |
| `environment` / `opencode.plugin.list` | `{plugins: [{id, source, version, status}], configurationSources: null, transformations: null}`. Fuente `builtin`, `local`, `package` o `sdk`; versión solo si la fuente de paquete la expone. No captura locators, rutas de plugins, opciones ni configuración. |

El lector valida la proyección por etapa y fuente, incluidos sus campos anidados,
además del hash; JSON arbitrario con hash correcto no acredita una forma admitida.
Conserva los desconocidos `null`: definición de skill no encontrada, adjunto de
skill no reconocido, ruta/contenido de archivo no leído, campos opcionales y
fuentes de configuración/transformaciones no expuestas. En un contexto de título,
agente y herramientas son `null`; las listas de fuentes de instrucciones y los
IDs de mensaje pueden ser `null`. Una observación `unrecognized` mantiene tanto
`value` como `sha256` en `null`.

El filtrado no exime de acreditar esa forma. Si cambia una clave de la proyección
(también en herramientas o esquemas anidados), o un discriminador exigido
(`kind`, roles de mensajes, modo de agente, fuente o estado de plugin), el productor
omite la proyección completa: `status: "unrecognized"`, `value: null`, `sha256: null`,
`unrecognized-observation-format` y `redacted-observation-shape` en `omissions`.
Conserva el sobre, la procedencia, los códigos de filtrado y las otras observaciones;
no conserva fragmentos de la proyección ni recupera los valores originales.
El texto libre filtrado cuya forma sigue siendo válida conserva su contenido y hash.
El lector no admite discriminadores sustituidos por marcadores ni claves alteradas
como excepción al esquema, tampoco en diarios anteriores: no los repara ni infiere
la estructura secreta a partir de `redactions` o del hash.

Los archivos no se leen fuera del proyecto, incluidos symlinks resueltos hacia
fuera (`definition-file-outside-project-not-read`); archivos no regulares o
ausentes producen omisiones y contenido `null`. Una lectura estática posterior
no acredita el texto cargado anteriormente ni el contexto del modelo
(`file-read-is-not-runtime-context`). La captura conserva por separado versiones
estáticas y transformadas aunque apunten a la misma ruta.

Las APIs de agentes no exponen sus archivos fuente; el registrador no los adivina.
La lista de plugins no atribuye cada transformación a su autor, orden de registro,
versión local o archivo de configuración. Esos datos quedan desconocidos y con
omisiones explícitas, no se deducen de la posición del array ni del nombre del
plugin. Las lecturas públicas de 2.1.2 tienen envoltura `{location, data}`;
el registrador consume `data`, no interpreta la envoltura como definición/array.

### Peticiones y punto de contexto

En 2.1.2 se observan por separado los hooks `context` (bucle principal, incluidas
continuaciones de herramientas; `kind: primary`), `compaction` (resumen),
`generate` (generación transitoria de sesión) y `title` (título, sin agente ni
herramientas). La cobertura de `recorder.ready` enumera esos puntos. Un hook puede
ejecutarse aunque otro posterior aporte un resultado y no despache modelo.

`system` conserva cada texto y, cuando se expone, su lista experimental
`metadata.experimental.instructions` de `{key, text}`. Ausencia y formas
desconocidas se señalan con `instruction-source-list-not-exposed` o
`unrecognized-instruction-source`. Esa lista es metadata copiada por OpenCode:
puede no coincidir con un texto editado después. `messages` conserva solo ID,
rol y partes textuales, no razonamiento, tool-call/tool-result, media, metadata
arbitraria ni checkpoints cifrados. `tools` conserva descripción y esquema de
entrada vistos en el hook, no ejecutores. Todo pasa por el mismo filtrado.

Se excluyen opciones de petición, cabeceras, hooks HTTP/protocolo posteriores,
frames WebSocket, generaciones sin sesión y trabajo anterior al arranque. No se
lee razonamiento privado. El servidor puede añadir instrucciones de compactación
después del hook. Otros plugins y transformaciones del protocolo pueden modificar
los datos después: `finalContext: false` y las omisiones se mantienen siempre.
No se afirma que esta proyección sea el contexto final ni que se haya enviado.

La prueba aislada contrasta una skill desplegada y su transformación pública,
admisión sin ejecución, activaciones repetidas, versiones de contenido en una
ruta mutable, los cuatro hooks y un hook posterior cuyo texto **sí** recibe el
proveedor sintético pero **no** estaba en la observación anterior. Solo conserva
evidencia sintética en temporales y no autoriza desplegar en Flujo en Proyecto.

## Consumo, duración y finalización (#7)

Las nuevas filas de eventos añaden `measurement` y `lifecycle`, objetos o `null`.
El lector admite los diarios anteriores sin ellos, sin completar sus métricas ni
acreditar desenlaces a partir del nombre del evento. Valida forma, discriminadores,
tipo de evento y versión pública antes de consultar; las omisiones y redacciones
no permiten eximir una forma inválida. Una clave o discriminador destruido por
el filtrado omite el objeto completo, como en las observaciones de #6.

### Valores de OpenCode y alcance

`measurement` tiene exactamente `kind`, `phase`, `model`, `startedAt`, `tokens`,
`costUSD`, `finish` y `error`. Valores ausentes son `null`, nunca ceros añadidos.

| Eventos públicos / versión | Proyección y alcance |
| --- | --- |
| `session.step.started` v1 | `kind: model-step`, `phase: started`, `model: {providerID, id}` y `startedAt` de `data.started`: tiempo de despacho, no escritura del diario. Resto `null`. |
| `session.step.streamed` v1 | `phase: streamed`; conserva en el sobre el límite de fin del cuerpo del proveedor (`sourceTime`), separado del asentamiento de herramientas. Otros valores `null`. |
| `session.step.ended` v1 | `phase: ended`, `tokens`, `costUSD` de `data.cost` y `finish`: `stop`, `length`, `tool-calls`, `content-filter`, `error` o `unknown`. No convierte el fin del paso en éxito del encargo. |
| `session.step.failed` v1 | `phase: failed`, error filtrado; consumo/coste opcionales y `finish: content-filter` si existe. Conserva lo disponible aunque termine en fallo. |
| `session.compaction.ended` / `.failed` v1 | `kind: compaction`, fase, consumo/coste opcionales y modelo si el evento lo expone; error en fallo. Solo alcance de sesión/compactación, sin asociarla al último mensaje, hook o ejecución. |
| `session.usage.updated` efímero, sin versión durable | `kind: session-total`, `phase: updated`, consumo y coste: **snapshot acumulado del runtime**, no consumo nuevo. Sin modelo, mensaje, llamada ni ejecución atribuidos. |

`tokens` conserva `{input, output, reasoning, cache: {read, write}}` tal como lo
informa el runtime; `costUSD` conserva su número finito no negativo. No se suman
categorías ni se recalcula un coste. `error` reutiliza la selección filtrada de
`type`, `message` y `status` de #5. Se excluyen `native`, `rawFinish`, snapshots,
archivos, cuerpos de error y metadata arbitraria. Modelo conserva la referencia
de proveedor/ID, no una atestación del modelo servido ni sus variantes/opciones.

**Observar un número del runtime no acredita una medición del proveedor.**
OpenCode puede normalizar uso ausente a cero. La captura conserva ese número
sin interpretarlo como ausencia de consumo; el diagnóstico declara siempre
`tokens.providerReported: null` y `basis: runtime-normalized-unverified`.
Las cifras que sí se recibieron por HTTP en la prueba son sintéticas; no hay
una marca pública que permita distinguir todos los ceros de normalización.
Sin campo público el valor queda `null`. El coste es una **estimación informada
por el runtime**, no cobro observado ni factura; no se garantiza la disponibilidad,
vigencia o procedencia de sus tarifas. Incluso coste cero no demuestra gratuidad.

Los pasos/reintentos conservan proyecto + sesión + mensaje de asistente. El
runtime no expone enlace causal a ejecución: `executionID` sigue `null`. Una
llamada de herramienta conserva además su propio `callID`; no hereda los tokens
del paso que la produjo. Los reintentos conservan número, fecha y error públicos,
con consumo/coste individuales desconocidos: no se reparten los del desenlace
entre intentos ni se cuentan intentos HTTP internos no expuestos. Un fallo
recuperado sigue accesible. `scheduledDelayMs` expresa solo la demora programada
del evento de reintento a `at`; `actualWaitMs: null` no inventa la espera real.
Tampoco se reparte consumo entre skills.

La generación de título y la generación transitoria tienen observaciones de
hook, pero no un evento público de uso individual aquí enlazable; se declara
`auxiliary-usage-attribution-not-exposed`. Un snapshot puede contener actividad
auxiliar: no se resta de él el último paso para inventar el consumo de un título,
ni se añade a pasos o compactaciones. Los hooks no prueban despacho.

### Desenlaces y trabajo pendiente

`lifecycle` se captura de `session.execution.started`, `.succeeded`, `.failed`
y `.interrupted` v1. Contiene `phase`, `reason`, `error` y `pendingWork`.
La interrupción conserva el motivo público `user`, `shutdown`, `superseded` o
`inactivity`; el fallo conserva el error filtrado. En las otras fases el motivo
es `null`. **`succeeded` solo acredita conclusión normal declarada por OpenCode**,
no aceptación de objetivos ni de descendientes. No hay un texto público de
trabajo pendiente: `pendingWork` permanece `null`, no una lista vacía.

El bloqueo se limita a la señal explícita `finish: content-filter` del paso.
No se deduce bloqueo de cualquier error, ni interrupción de toda herramienta por
interrumpir una sesión. Las solicitudes externas sin réplica observada y los
items de inbox sin entrega/cancelación observada se conservan como evidencia
pendiente al horizonte leído, no como un snapshot causal del instante de fin.
Una respuesta externa no identifica al actor humano; una espera no prueba que
las demás ramas hayan dejado de trabajar. Ausencia de fin nunca acredita éxito.

### Consulta independiente

`inspect.mjs <directorio> <sesión> --metrics` selecciona raíz y descendientes con
las mismas relaciones de `--tree`. No atribuye filas con identidad excluida a
la sesión seleccionada. Emite JSONL de diagnóstico sin alterar la captura:

- `diagnostic.model-step`: modelo, métricas, tiempos, desenlaces y reintentos por
  identidad pública; `dispatches` conserva cada inicio observado y su modelo sin
  atribuirle consumo/coste por proximidad. El orden de esos arrays es de lectura,
  no cronología entre diarios. `results` conserva todos los resultados. Resultados múltiples
  no se colapsan en éxito ni se suman: el resumen queda `ambiguous`.
- `diagnostic.measurement`: observaciones individuales de compactación o snapshots
  de sesión, nunca filas de consumo aditivo.
- `diagnostic.execution-interval`: pares observados de inicio/fin dentro del mismo
  diario, proyecto, sesión y agregado, ordenados solo por su secuencia pública.
  `intervalRef` referencia evidencia, **no** es un ID causal de ejecución. Un nuevo
  inicio deja abierto el anterior; no se cruza un hueco/fallo declarado de captura.
  Sin extremo, identidad o secuencia suficientes, la duración es `null`.
- `diagnostic.wait`: intervalo de solicitud/réplica por ID público; abierto queda
  `waiting-external-decision`, con duración total y desenlace desconocidos.
- `diagnostic.pending-inbox`: admisión sin entrega/cancelación observada, no una
  ejecución completada. Agrupa proyecto + sesión + mensaje y resuelve la admisión
  solo con una entrega/cancelación de secuencia posterior en el mismo agregado,
  incluso si está en otro diario leído antes. Sin resolución conserva
  `delivery-not-observed`; con resolución cuyo orden no se acredita conserva
  `state: unknown`, ambas evidencias e `inbox-resolution-order-not-established`.
  No usa tiempos de reloj para inventar ese orden. `diagnostic.tool-attempt`
  reutiliza íntegramente #5.
- `diagnostic.metric-coverage`: límites y referencias de diagnósticos globales.

Cada métrica de modelo, tokens o coste indica `value`, `status`, `source` y
`scope`. `observed` significa valor público del runtime, `estimated` coste
informado por ese runtime, y `unknown` falta de valor; no se estiman ausencias.
Todas las filas conservan referencias `evidence` y los `horizons` de los diarios
leídos, además de omisiones. No son evaluaciones, rúbricas ni puntuaciones.

`elapsedMs` resta tiempos observados solo con ambos extremos no invertidos;
`durationSource` declara su procedencia. En un paso va del primer despacho
observado al terminal, incluidas esperas de reintento. Los despachos de una misma
identidad se comparan por secuencia pública dentro de su agregado, también entre
diarios. Sin un primero comparable o con tiempos contradictorios con ese inicio,
`startedAt` y duración quedan en `null` con `dispatch-order-not-established`.
Para medir hasta el terminal se exige además que todos los despachos lo precedan
en ese agregado y que sus tiempos fuente no sean posteriores al fin; si no,
la duración es `null` con `step-duration-order-not-established`.
No se comparan UUID, `arrival` ni `observedAt` entre activaciones.
`providerBodyMs` termina en
`streamed`, antes del asentamiento de herramientas; con varios despachos queda
`null` porque no se expone el enlace causal a un despacho concreto. Con uno exige
secuencia comparable y tiempos no invertidos; en otro caso declara
`provider-body-order-not-established`. Varios límites `streamed` no se colapsan
por orden de archivo (`multiple-step-streams-not-collapsed`).
En herramientas va de `called` al terminal; en ejecución y espera usa sus
eventos públicos. Son **intervalos transcurridos**, no tiempo de CPU, trabajo
exclusivo ni intervalos a sumar: pueden solaparse e incluir esperas.
Los límites causales del flujo no se exponen: `flowElapsedMs: null`; no se suma
concurrencia ni se resta una espera compartida para inventar duración activa.
Los relojes pueden variar y no existe un orden causal global entre diarios.
La suscripción sin replay tampoco demuestra ausencia de pérdidas no señaladas.

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
adjuntos ni entregables. Instrucciones, definiciones y skills solo tienen la
cobertura explícita de #6, no una copia universal del entorno ni contexto final.
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
