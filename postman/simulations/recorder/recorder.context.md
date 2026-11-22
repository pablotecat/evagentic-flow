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
el harness toma el puerto del evento `listening` y conserva `sim.ndjson` en el
directorio temporal del caso. Ejecución manual:
`postman simulation run postman/simulations/recorder/recorder.sim.yaml --port auto --output ndjson --no-history`.
Se considera ejercitada solo cuando el log tiene un POST servido por `model`.

## Assumptions

- Respuestas fijas y SSE con un secreto sintético dividido entre fragmentos;
  no valida el comportamiento de ningún modelo real. (Observado 2026-11-21.)
- Postman CLI 1.83.1 y OpenCode 2.1.2 funcionan juntos con este handler; el servidor
  puede solicitar también un título, por lo que no se asume un solo POST por
  encargo. (Observado 2026-11-21 en las pruebas de persistencia y selección.)
- El bootstrap del motor de datasets puede superar 20 s con HOME nuevo. El
  harness espera hasta 60 s y conserva `sim.err`. (Observado 2026-11-22.)
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

## Observations

<!-- begin:observations -->
2026-11-22: suite final de #5, 23/23 pruebas aprobadas tras incluir claves sensibles
prefijadas y secretos escapados en JSON completo. `synthetic-model`, único miembro,
sirvió 200, 400 y 429 controlados; ningún miembro quedó sin ejercitar en el conjunto.
Las pruebas utilizaron el paquete instalado, APIs públicas y lector independiente.
Sin activar el plugin en el consumidor ni tocar el servicio compartido.
2026-11-22: seis pruebas focales de #5 aprobadas: herramienta local satisfactoria,
fallo y recuperación, intento sin desenlace tras terminar el proceso aislado,
pregunta/aprobación controladas, reintento de proveedor y exclusiones de formularios.
El único miembro, `synthetic-model`, sirvió chat con 200 y los 429 controlados;
no quedó ningún miembro sin tráfico en el conjunto. El caso de formularios por
API pública no requirió simulación. Sin consumidor real ni servicio compartido.
2026-11-22: suite completa de #4, 17 pruebas aprobadas; `synthetic-model` fue el
único miembro y sirvió chat con 200 y el fallo deliberado con 400. La preparación
rechazada no despachó modelos; ningún miembro quedó sin tráfico en el conjunto.
2026-11-22: pruebas focales de #4 y regresiones de fallo aprobadas. El único miembro,
`synthetic-model`, sirvió POST de chat con 200, incluidas llamadas nativas a
`subagent`; ninguno quedó sin tráfico. Sin proveedor probabilístico ni consumidor real.
2026-11-22: suite final, 15 pruebas aprobadas. El único miembro, `synthetic-model`,
sirvió POST de chat con 200 y el fallo deliberado con 400. Los casos de preparación
fallida no despacharon POST, intencionadamente; ningún miembro quedó sin ejercitar
en el conjunto. La carrera confirmó cero despachos de la admisión retenida mediante
el contador HTTP, no contando respuestas SSE aún abiertas en NDJSON.
2026-11-21: suite final, 7 pruebas aprobadas. En los tres casos con simulación,
`synthetic-model` sirvió POST de chat con 200; ningún miembro quedó sin tráfico.
2026-11-21: pruebas de persistencia y selección de ambos proyectos: el único miembro
`synthetic-model` recibió POST `/v1/chat/completions` con respuesta 200. Ningún
miembro quedó sin tráfico; se comprobaron los eventos `request` del log local.
<!-- end:observations -->

## What didn't work

- 2026-11-22: un arranque aislado falló antes de `listening` con `Permission denied
  while accessing local dataset files`. El mismo test pasó en otra instancia
  temporal; causa no confirmada. Ese intento no llegó a ejecutar el registrador.
