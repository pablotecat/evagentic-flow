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

## Observations

<!-- begin:observations -->
2026-11-21: suite final, 7 pruebas aprobadas. En los tres casos con simulación,
`synthetic-model` sirvió POST de chat con 200; ningún miembro quedó sin tráfico.
2026-11-21: pruebas de persistencia y selección de ambos proyectos: el único miembro
`synthetic-model` recibió POST `/v1/chat/completions` con respuesta 200. Ningún
miembro quedó sin tráfico; se comprobaron los eventos `request` del log local.
<!-- end:observations -->
