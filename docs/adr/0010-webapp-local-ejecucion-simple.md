# Webapp local con ejecución simple e histórico persistente

Implementa el primer corte vertical de [#24](https://github.com/pablotecat/evagentic-flow/issues/24)
([#25](https://github.com/pablotecat/evagentic-flow/issues/25)): lanzar un encargo
simple desde una webapp local real y consultar su respuesta y estado en un
histórico persistente, sin leer archivos. No sustituye las decisiones de captura
del [ADR 0005](0005-captura-local-integrada-en-opencode.md): las conserva.

## Decisiones

- **Stack mínimo sin framework.** Servidor HTTP de la biblioteca estándar de
  Node y una interfaz de navegador con HTML/CSS/JS estático. No se añade
  framework, base de datos ni herramienta de diagramas: el ADR 0005 exige la
  solución mínima. Playwright entra sólo como `devDependency` de prueba, y
  únicamente para la frontera aprobada de navegador.
- **App separada, motor reutilizado.** `webapp/` es una app propia que controla
  una instancia dedicada de OpenCode 2.1.2 mediante su API pública HTTP (crear
  sesión raíz nueva, enviar el encargo inicial, consultar `/api/info`). No lee
  su base de datos ni sustituye sus interfaces. La configuración local no
  versionada (`version: 1`) fija URL loopback del motor, contraseña, proyecto
  observado, directorio de captura y destino de datos de la app
  (`examples/webapp.example.json` como plantilla sintética).
- **El índice no es una vía alternativa de contenido.** El índice persistente
  de ejecuciones sólo guarda identidad, clave de solicitud, proyecto, sesión
  raíz, tiempos, despacho y desenlace técnico. El encargo y la respuesta
  mostrados en el histórico proceden exclusivamente de la captura autorizada y
  filtrada del registrador, consultada con el lector independiente
  `scripts/inspect.mjs` reutilizado como proceso hijo. No se importan capturas
  previas ni se identifican activaciones del registrador con ejecuciones: el
  histórico sólo contiene ejecuciones creadas desde la app.
- **Identidad propia por lanzamiento.** Cada lanzamiento genera una identidad de
  ejecución distinta de la sesión raíz y de los `captureID` referenciados; la
  interfaz los muestra por separado.
- **Candado por proyecto en el servidor.** Una sola ejecución activa por
  proyecto, aplicada en memoria y persistida en el índice, de modo que también
  vale entre pestañas y tras reiniciar la app. Sin cola: una segunda solicitud
  distinta recibe `409` mientras el desenlace no esté comprobado.
- **Creación idempotente por `requestKey`.** Repetir la misma solicitud
  recupera la misma ejecución sin reenviar el encargo, aunque se hubiera
  perdido la respuesta anterior. El cliente genera la clave por conversación
  y la conserva al reintentar.
- **Despacho sin desenlace comprobado.** Si no puede confirmarse la sesión o
  el desenlace, la ejecución queda `pending`/`running` y el proyecto no se
  libera; nunca se reenvía el trabajo. La finalización técnica sólo se
  registra a partir de filas `session.execution.*` de la captura; el
  `idle` o la caída del motor no acreditan desenlace.
- **Cierre técnico no es aceptación.** El estado expone desenlace técnico
  observado y salud de captura por separado; la evaluación queda fuera de este
  corte y no se muestran puntuaciones.
- **Un único envío inicial.** La conversación de una ejecución no habilita
  nuevos turnos de trabajo ni un botón «Finalizar ejecución» (aplazado a #22).
  «Nuevo encargo» abre otra conversación con otra clave; el candado decide.
- **Seguridad local.** El servidor sólo escucha en `127.0.0.1` y rechaza
  peticiones cuyo `Host` u `Origin` no sea la propia interfaz, para que
  páginas externas no puedan despachar trabajo. No usa cookies ni acceso
  remoto; sigue sin activarse el piloto real ni el servicio compartido.
- **Reutilización de la frontera de pruebas.** Las pruebas usan
  `test/support/instance.mjs` (instancia aislada real), la simulación Postman
  sintética existente y el vigilante de admisión sintético para ocupar el
  proyecto. Sólo OpenCode, el registrador y el proveedor HTTP sintético
  participan; nunca credenciales reales.

## Frontera de pruebas

- `test/webapp.test.mjs`: API pública de la app contra instancia real —
  lanzamiento, respuesta autorizada, idempotencia por clave, rechazo con
  proyecto ocupado, desenlace pendiente tras pérdida, persistencia tras
  reinicio de la app, lectura del histórico con el motor caído y rechazo de
  orígenes ajenos.
- `test/browser.test.mjs`: navegador real (Playwright) con app, OpenCode y
  registrador reales y proveedor HTTP sintético — estado
  disponible/no disponible, envío único, respuesta y finalización técnica,
  carrera de peticiones simultáneas sin doble despacho, recarga sin relanzar,
  rechazo entre pestañas e histórico tras reinicio con y sin motor.

## Límites

- La reconciliación del desenlace es perezosa: se comprueba al consultar la
  app, no con temporizadores internos. El candado se reevalúa en cada
  consulta, por lo que una pestaña cerrada no bloquea la comprobación.
- Una ejecución `pending` sin sesión confirmada no se reenvía nunca y
  mantiene el proyecto ocupado hasta que exista desenlace observado; este
  corte no ofrece desbloqueo manual (la revisión tras pérdida de desenlace
  es la vía prevista).
- La salud de captura resume la última declaración global
  `recorder.ready`/`recorder.failed` del destino configurado; no es una
  garantía de cobertura de la ejecución concreta.
