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
| `type` | `recorder.ready`, `recorder.failed`, `recorder.gap` o el tipo público `session.*`. |

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

Un fallo de preparación deja el plugin público en estado `failed` y no constituye
preparación satisfactoria. Si la propia confirmación de disco falla, cualquier
archivo `.pending` creado debe considerarse incompleto aunque contenga una fila
`recorder.ready`; el estado público fallido prevalece. No usar solo la presencia
de un archivo para decidir que se puede trabajar.

`recorder.failed` añade `reason: "event-stream-or-persistence-failure"`. Es un
diagnóstico del registrador, **no** un hecho del flujo ni una causa del fallo del
agente. Puede no escribirse si el disco falla; también se avisa en stderr del
servidor. No hay recuperación automática ni replay. La issue #3 debe resolver
aviso nativo e interrupción efectiva antes del piloto.

`recorder.gap` añade `reason: "unrecognized-session-envelope"`: un evento de
sesión observable no trae el sobre necesario para atribuirlo. Conserva solo el
diagnóstico de cobertura, nunca su payload, tipo original ni identidades sin
verificar. Una ubicación explícita ajena se excluye antes de este diagnóstico.

## Evidencia de eventos

Además del sobre, todas las filas `session.*` incluyen:

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
| `status` | `captured`, `omitted` o `unrecognized`. |
| `omissions` | Array de códigos de omisión, sin datos originales. |
| `redactions` | Array de códigos de filtrado, sin los valores eliminados. |

Solo se captura texto de `session.inbox.enqueued` con item `user` (encargo ya
admitido, versión durable `1`) y `session.text.ended` (bloque final de respuesta,
versión durable `1`). Un encargo admitido con `resume: false` **no** demuestra
ejecución. Un bloque final no demuestra por sí solo éxito global del encargo.
Los eventos `session.execution.*` conservan sus identidades/tiempos como
metadatos; su ID de evento identifica ese hecho, no se reutiliza como ID causal
de otros eventos. No se asocian respuestas al último encargo por orden de llegada.

Los demás eventos de sesión observables conservan sobre y metadatos permitidos,
pero **no payload** (`status: omitted`, `event-payload-not-captured`). Los campos
no textuales del encargo/respuesta quedan excluidos (`non-text-fields-not-captured`).
Un texto reconocido con forma o versión no admitida queda sin contenido y con
`status: unrecognized`, `unrecognized-content-format`. Un tipo/forma de item de
inbox desconocido lleva `unrecognized-inbox-format`. Los identificadores con
formato no permitido o con secretos configurados se sustituyen por `null` y se
señalan con `unsafe-identifier`. Nunca se conserva un payload desconocido como
fallback. No se afirma que el SDK entregue eventos que él mismo no reconoce.

## Alcance y cobertura real

La instancia del plugin solo escribe si su ubicación coincide con el directorio
autorizado resuelto mediante `realpath`. Cada evento se filtra de nuevo por su
ubicación cuando existe y por el ID de proyecto y ubicación públicos de su sesión.
No se asume que el stream sea local al plugin. Los eventos de otro proyecto no
se registran, ni siquiera sus IDs. Si no se puede comprobar una sesión, la captura
falla visiblemente en vez de atribuirle contenido por inferencia.

El stream es **en vivo**: no se recupera lo anterior al arranque y puede faltar
`session.created` cuando la carga del plugin se difiere hasta el primer prompt.
No se capturan eventos globales, texto de deltas, razonamiento, herramientas,
adjuntos, instrucciones, definiciones, skills ni entregables en este corte.
Si una respuesta se interrumpe antes del bloque final, no se recupera su texto
parcial. No se demuestra cobertura de subejecuciones, concurrencia, sesiones
movidas, cancelación de descendientes ni efectos externos.

## Exclusión de secretos

Los valores literales de `secrets` se reemplazan por `[REDACTED]` antes de escribir
texto (`configured-literal`). También se filtran patrones reconocibles de
Bearer/Basic, asignaciones de claves/tokens/contraseñas y bloques PEM privados
(`credential-pattern`). Se trabaja sobre el bloque completo, no sobre fragmentos
que podrían dividir una credencial. Solo entran campos explícitamente permitidos;
no se serializan metadata arbitraria, cabeceras, configuración global ni errores
con contenido original. No se promete detectar cualquier secreto en texto libre,
codificado u ofuscado. Revisar la configuración local antes de activar cada caso.

Los diarios no contienen rutas del consumidor. Tanto capturas como configuración
local quedan fuera de control de versiones y no se publican automáticamente.

Referencias públicas comprobadas: [plugins de servidor V2](https://opencode.ai/v2/docs/build/plugins/server),
[API V2](https://opencode.ai/v2/docs/api), [cliente V2](https://opencode.ai/v2/docs/build/client).
