# Recorder · contexto de simulación

Creada el 2026-11-21. Proveedor deliberadamente sintético, no una réplica de un
servicio consumidor: no se buscó un mock de un propietario externo. Protocolo
chat OpenAI-compatible mínimo en `postman/mocks/synthetic-model/default.js`.

## Purpose

Probar el plugin real cargado en OpenCode frente a HTTP local, sin proveedor de
modelos real, credenciales ni datos del piloto. El contrato sintético rechaza
rutas no modeladas con 501 y solicitudes incompatibles con 400.

## Execution

`npm test` inicia y detiene esta simulación junto con cada instancia aislada;
el harness toma el puerto del evento `listening` y conserva `sim.ndjson`, `sim.err`,
`sim.cli.log` y `sim.process.json` en el directorio temporal del caso. Diagnóstico
y límites en [bootstrap de datasets](../../../docs/postman-bootstrap.md). Ejecución manual:
`postman simulation run postman/simulations/recorder/recorder.sim.yaml --port auto --output ndjson --no-history`.
Se considera ejercitada solo cuando el log tiene un POST servido por `model`.

## Assumptions

- Respuestas fijas y SSE con un secreto sintético dividido entre fragmentos;
  no valida el comportamiento de ningún modelo real. (Observado 2026-11-21.)
- Postman CLI 1.83.1 y OpenCode 2.1.2 funcionan juntos con este handler; el servidor
  puede solicitar también un título, por lo que no se asume un solo POST por
  encargo. (Observado 2026-11-21 en las pruebas de persistencia y selección.)
- El bootstrap del motor de datasets puede superar 20 s con HOME nuevo. El
  harness permite hasta 60 s mientras siga vivo; una salida terminal se comunica
  sin agotar ese plazo y conserva el diagnóstico con debug solo en Postman.
  (Bootstrap observado 2026-11-22; frontera proceso/OS verificada 2026-11-23, #12.)
- El harness reutiliza un HOME temporal de Postman por archivo de pruebas para no
  reinstalar el motor por caso; cada simulación sigue siendo un proceso nuevo y
  OpenCode conserva almacenamiento separado por caso. No usa el HOME real.
  (Ajustado 2026-11-22 tras fallos intermitentes del bootstrap.)
- NDJSON notifica solicitudes al terminar la respuesta, no su inicio: no contar
  SSE todavía abiertas para probar ausencia de despacho. La carrera usa un
  contador HTTP en el miembro sintético. (Observado 2026-11-22 en la prueba de admisión.)
- Code Mode representa el error provocado como herramienta completada con
  `metadata.error: true`, no `session.tool.failed`; la prueba consulta también
  sus mensajes públicos. (Observado 2026-11-22 en la prueba de herramienta.)
- Los avisos automáticos de subagentes pueden iniciar otra ronda en el padre:
  contar bloques de respuesta no cuenta sesiones ni invocaciones de delegación.
  (Observado 2026-11-22 en `test/delegation.test.mjs`.)
- Las herramientas sintéticas se registran mediante la API pública de plugins;
  el proveedor solo decide sus llamadas, sin sustituir su ejecución. El nombre
  efectivo del namespace `synthetic.actions` fue `synthetic_actions_inspect`.
  `executed` fue `false` incluso con resultado local observado. (Observado 2026-11-22.)
- Un primer 429 se recuperó dentro del proveedor sin `session.retry.scheduled`.
  Tres 429 seguidos expusieron ese evento, con intento `2`, antes de recuperar.
  No se equipara ese intento con cada petición HTTP interna. (Observado 2026-11-22.)
- La pregunta nativa produjo `form.*`, no `question.*`, con enlace en
  `metadata.kind: question` y `metadata.tool.id/messageID`; sus respuestas no
  exponen actor autenticado. Las aprobaciones produjeron `permission.*` con
  `source` de herramienta. (Observado 2026-11-22 mediante APIs públicas aisladas.)
- Los casos `SYNTHETIC_USAGE_A/B` añaden cifras distintas por SSE. Sin ese uso,
  OpenCode informó ceros normalizados; no acreditan consumo cero del proveedor.
  La generación transitoria devolvió texto sin `tokens` en este binario 2.1.2.
  (Observado 2026-11-22 en las pruebas focales de #7.)
- Un reintento puede emitir varios `session.step.started` con el mismo mensaje;
  sobrescribir su inicio ocultaba esperas. La consulta conserva los despachos sin
  repartirles uso ni atribuirles duración de cuerpo. (Observado 2026-11-22, #7.)

## Observations

<!-- begin:observations -->
2026-11-23: #12, suites iniciales 82/82 y 82/82; tras cubrir copia inaccesible del
log, dos suites finales consecutivas 83/83 y 83/83. Sin reintentos ni fallo natural
de bootstrap. `synthetic-model`, único miembro, sirvió 200/400/429 en las cuatro;
ninguno quedó sin tráfico en el conjunto. Seis arranques naturales de
frío/caliente y aislamiento sirvieron HTTP 200. Esto no demuestra erradicación.
2026-11-23: regularización de #2–#4 sobre `30b2d40`: suite completa 77/77 y
typecheck correctos, sin reintentos de pruebas. Los logs locales del único miembro,
`synthetic-model` (routeKey `model`), muestran tráfico 200/400/429; ninguno quedó
sin ejercitar en el conjunto. Sin fallo de bootstrap observado; #12 sigue abierta.
2026-11-23: focales de #8, 7/7; la suite completa terminó 71/72 por el bootstrap
descrito abajo, sin reintentos. `synthetic-model`, único miembro, sirvió tráfico
200/400/429 en el conjunto; quedó sin arrancar en el caso de cookies. Las siete
pruebas nuevas pasaron también dentro de la suite completa.
2026-11-22: suite final de #7 aprobada (55/55), sin retries de pruebas ni fallos
de bootstrap; #12 sigue como seguimiento, no se declara resuelto. `synthetic-model`,
único miembro, sirvió 200 y fallos controlados 400/429; ninguno quedó sin tráfico
en el conjunto. Se comprobaron consumos concurrentes distintos, coste sintético,
despachos repetidos, espera externa, filtro de contenido, interrupción y ausencias
mediante paquete instalado, APIs públicas y lector independiente. No se verificó
compactación satisfactoria ni procedencia del consumo real de un proveedor.
2026-11-22: suite de #6 aprobada (31/31) con HOME temporal de Postman reutilizado
por archivo, sin reintentos automáticos. `synthetic-model`, único miembro, sirvió
chat 200 y fallos controlados 400/429; ninguno quedó sin tráfico en el conjunto.
El control HTTP confirmó instrucciones de un hook posterior ausentes del punto
observado por el registrador. No demuestra contexto final universal ni cumplimiento.
<!-- end:observations -->

## What didn't work

- 2026-11-23: #12, un handle exclusivo propio sobre el motor extraído produjo
  salida 1 antes de `listening`, sin tráfico, con `An unexpected error occurred
  while accessing the dataset`; liberarlo permitió otro arranque explícito con
  HTTP 200. No es la firma EPERM histórica. Debug no identificó syscall/archivo;
  falta una captura OS de reproducción natural. Evidencia y límites en el documento enlazado.
- 2026-11-23: `npm test` falló en `Cookie y Set-Cookie completos...` antes de
  `listening`: `Permission denied while accessing local dataset files` al preparar
  soporte de datasets de Postman. El caso no llegó a ejecutar el registrador;
  las otras 71 pruebas pasaron. Evidencia local: `sim.err` del caso fallido.
  Causa raíz sin confirmar; #12 se mantiene como seguimiento, sin retries
  automáticos ni repetición para presentar la suite como aprobada.
- 2026-11-23: una continuación tras resultado `file` con MIME `text/plain` falló
  en el proveedor OpenAI Chat de OpenCode con `OpenAI Chat does not support media
  type text/plain`, antes de HTTP. #8 consulta esas referencias en sesiones
  separadas; la producción/lectura nativa sí concluye en una misma sesión.
- 2026-11-22: la prueba auxiliar de #7 esperaba una compactación satisfactoria,
  pero el texto genérico del proveedor produjo `compaction.failed` con
  `Compaction summary did not match the required template`. El caso ahora verifica
  ese fallo público y sus cifras de runtime, no afirma compactación satisfactoria.
- 2026-11-22: dos ejecuciones completas de #6 quedaron en 30/31 por el mismo
  `Permission denied while accessing local dataset files` antes de `listening`,
  en casos distintos. La repetición focal del primer caso pasó. Causa raíz no
  confirmada; se evita reinstalar el motor por cada caso, sin reintentos automáticos.
- 2026-11-22: un arranque aislado falló antes de `listening` con `Permission denied
  while accessing local dataset files`. El mismo test pasó en otra instancia
  temporal; causa no confirmada. Ese intento no llegó a ejecutar el registrador.
