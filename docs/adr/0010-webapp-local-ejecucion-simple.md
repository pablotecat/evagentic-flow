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
- **Despacho sin desenlace comprobado.** Crear la sesión sólo acredita
  `session-confirmed`; antes de intentar el encargo se persiste `possibly-sent`.
  Ambos conservan `pending`, sin fecha de admisión. Sólo la respuesta pública
  de admisión o una fila `session.inbox.enqueued` con identidad de mensaje
  acreditan `admitted` y `running`. Si se pierde la respuesta, se reconcilia
  la captura, sin reenviar el trabajo. La finalización exige la última fase
  pública terminal por secuencia de cada sesión conocida del árbol, además de
  comprobar por API pública ausencia de actividad, formularios y permisos.
  Se vuelve a enumerar el árbol antes de cerrar; un descendiente ausente,
  evidencia insuficiente, avería de captura o motor inaccesible conserva la
  exclusión. `idle` o caída del motor no acreditan desenlace.
- **Transiciones persistidas antes de publicarlas.** La reconciliación y la
  reserva de nuevas claves se serializan en el servidor; no se encola trabajo.
  Una carrera que atraviesa el cierre anterior sigue recuperando la misma
  ejecución. El estado candidato se escribe antes de modificar la vista en
  memoria o liberar el proyecto. Al abrir el índice se arma previamente
  `index-review-required`, y sólo un cierre sano de la app lo retira. Una avería
  bloquea nuevas escrituras y lanzamientos, sin una cola de promesas rechazada
  ni reintentos automáticos. Reparar la ruta no acredita revisión; el marcador
  conserva el bloqueo tras reiniciar, incluso al restaurar el directorio que
  se perdió. Un cierre abrupto también exige revisión conservadora. La salud pública del índice indica
  `review-required` y los nuevos lanzamientos reciben `503`. El histórico y
  las claves ya existentes siguen consultables si el índice es legible.
  La revisión manual debe contrastar índice, marcador y captura antes de
  retirar el marcador con la app detenida; no hay desbloqueo automático ni UI
  de recuperación en este corte.
- **Cierre técnico no es aceptación.** El estado expone desenlace técnico
  observado y salud de captura por separado; la evaluación queda fuera de este
  corte y no se muestran puntuaciones.
- **Un único envío inicial.** La conversación de una ejecución no habilita
  nuevos turnos de trabajo ni un botón «Finalizar ejecución» (aplazado a #22).
  «Nuevo encargo» abre otra conversación con otra clave; el candado decide.
- **Seguimiento fuera de la pestaña ([#26](https://github.com/pablotecat/evagentic-flow/issues/26)).**
  El ciclo de vida sigue perteneciendo al servidor local: recargar o cerrar
  el navegador no detiene el trabajo ni despacha otro encargo, y reabrir
  recupera identidad, sesión raíz y evidencia persistidas. La conexión del
  navegador con la app se muestra como señal propia («Sin conexión con la
  app local») separada del motor, la captura y el desenlace. Con el motor
  inaccesible y una ejecución no terminal, la vista muestra «desenlace
  pendiente de comprobar» y nunca éxito ni consumo; el aviso se retira al
  volver a alcanzar el motor, sin que una reconexión acredite por sí sola
  el desenlace ni reenvíe el encargo. El detalle histórico expone el
  horizonte temporal de la evidencia («Evidencia hasta»: el último momento
  observado del árbol de sesiones acreditado por la captura, con su alcance
  explícito), distingue «sin filas de
  captura» de «captura no consultable», y no reconstruye texto no capturado:
  no hay replay ni backfill. Publica las omisiones observadas con referencias
  a sesión, captura y fila. Las declaraciones globales `recorder.gap` se
  muestran como lagunas del destino de captura sin atribuirlas a la ejecución:
  no identifican una sesión afectada ni amplían el horizonte del árbol.
  La app puede relanzarse en el mismo puerto
  (puerto interno opcional) para comprobar que la reconstrucción parte del
  índice persistente, no de la memoria del navegador.
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
  #26 añade recarga y cierre del navegador con trabajo en curso
  (identidad, ausencia de nuevos despachos y bytes de captura preservados),
  reinicio de la app en el mismo origen con la pestaña abierta (señal de
  desconexión, reconciliación desde el índice sin reenvío) y caída del motor
  en curso con aviso de desenlace pendiente, proyecto ocupado al reconectar
  y consulta histórica sin motor.

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
