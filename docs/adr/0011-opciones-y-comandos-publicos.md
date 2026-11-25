# Selección de agente y modelo y ejecución de comandos públicos

Implementa el corte vertical [#27](https://github.com/pablotecat/evagentic-flow/issues/27)
de [#24](https://github.com/pablotecat/evagentic-flow/issues/24): el chat de la webapp
presenta los agentes, modelos y comandos que expone la instancia dedicada para el
proyecto configurado y el encargo se puede lanzar con esas selecciones o mediante un
comando existente con sus argumentos. No sustituye las decisiones del
[ADR 0010](0010-webapp-local-ejecucion-simple.md); las conserva y extiende.

## Decisiones

- **Sólo interfaces públicas de OpenCode 2.1.2.** Las opciones se consultan con
  `GET /api/agent`, `GET /api/model` y `GET /api/command` con
  `location[directory]` del proyecto configurado. La selección se aplica con
  `POST /api/session/{id}/agent` y `POST /api/session/{id}/model`, y el comando se
  ejecuta con `POST /api/session/{id}/command` usando `{name, text}`. No se envía
  un prompt equivalente inventado: el texto del usuario viaja como `text` y
  OpenCode expande la plantilla del comando (`$ARGUMENTS`) antes de admitir el
  mensaje; la app no reconstruye ese resultado. No se añaden terminal,
  explorador ni edición de agentes o configuración.
- **Identidad de opciones según el listado.** Un modelo se identifica como
  `proveedor/modelo[#variante]` exactamente por las variantes que expone
  `GET /api/model`; la instancia sintética sólo expone variantes, así que no se
  publica una entrada base sin variante que el listado no respalde. Un agente se
  identifica por su `id` público. Las selecciones opcionales: sin elegir agente o
  modelo, la sesión conserva los suyos.
- **Estabilidad del registro.** El registro de opciones de OpenCode 2.1.2 se
  llena de forma asíncrona tras resolver la ubicación: `_api/agent` puede
  devolver primero sólo los agentes integrados y añadir los agentes de
  configuración unos cientos de milisegundos después. La app resuelve la
  ubicación con `GET /api/location?location[directory]` y repite el listado hasta
  que dos lecturas consecutivas coinciden (tope de 5 s), en vez de publicar el
  primer listado parcial. Los estados de carga, vacío y error de cada colección
  son visibles en el chat.
- **Rechazo explícito de opción no disponible.** Con el motor accesible, la
  creación valida agente, modelo y comando contra el listado actual: una opción
  ausente responde `422 selection-unavailable` con la opción y su clase, sin
  crear ejecución, sin tomar el candado del proyecto y sin despachar nada. El
  despacho revalida contra el listado vivo antes de aplicar cada selección y
  conserva pendiente un envío posible cuya respuesta sea un error, incluido
  HTTP 404: el estado HTTP no demuestra un rechazo anterior a la admisión.
  Sólo la reconciliación con evidencia suficiente puede liberar el candado.
  No hay sustitución silenciosa, ni valor por defecto oculto, ni segundo intento:
  la misma clave nunca reenvía el encargo.
- **Selección conocida y su procedencia.** La elección del usuario se persiste
  como `requested*`; lo efectivamente conocido se observa después por la API
  pública de la sesión (`agent` de la sesión y `model` de `GET /api/session`,
  respaldados por los mensajes públicos `agent-switched` y `model-switched`)
  durante una ventana acotada tras aplicar las selecciones, y se guarda con la
  procedencia `public-session`. Si no llega a observarse, queda explícitamente
  sin confirmar. El texto del encargo y de los argumentos no se persisten en el
  índice: las vistas siguen leyendo exclusivamente la captura del registrador,
  que contiene la plantilla ya expandida admitida en la sesión.
  Del comando sólo se conserva y publica el nombre; los argumentos permanecen
  en memoria hasta el único envío. Al cargar índices anteriores se descartan
  argumentos y propiedades adicionales del comando de la proyección en memoria;
  no se sobrescribe el archivo antiguo al consultar el histórico. Una escritura
  posterior del índice también usa esa metadata limitada, sin alterar capturas.
- **Lanzamiento único intacto.** La ejecución con selecciones o comando conserva
  la idempotencia por `requestKey`, el único envío por conversación y la
  exclusión de otra ejecución activa: repetir la misma solicitud recupera la
  misma ejecución sin reenviar, y el candado por proyecto decide igual que en
  el corte anterior. La admisión de un comando se acredita igual que la de un
  encargo: sólo con la respuesta pública del envío o con una fila
  `session.inbox.enqueued` en la captura.
  Una clave existente se recupera antes de consultar el catálogo vivo, incluso
  si la opción desapareció o el motor no está disponible.

## Frontera de pruebas

- `test/webapp.test.mjs` añade: exposición de opciones sintéticas (agente de
  configuración, modelo variante del proveedor sintético y comando de archivo
  global) contra una instancia real; lanzamiento con agente, modelo variante y
  comando con argumentos verificados en la captura (plantilla expandida) y en
  la selección conocida de la API pública; idempotencia por clave sin segundo
  despacho ni segunda sesión raíz; rechazo `422` de agente, modelo y comando no
  expuestos sin crear ejecución, sesión ni admisión; opción de comando
  desaparecida (archivo eliminado y listado actualizado) rechazada igual y sin
  bloquear el proyecto; estado `engine-unreachable` de las opciones con el motor
  caído. Las regresiones de #35 comprueban argumentos secretos filtrados y
  propiedades extra ausentes de índice/listado/detalle, proyección segura de un
  índice antiguo sin sobrescribirlo al consultar, y recuperación de la misma
  clave tras desaparecer el comando y con el motor caído. Un plugin sintético
  real elimina la sesión para provocar un 404 ajeno al comando y comprobar que
  el envío posible no libera la exclusión.
- `test/browser.test.mjs` añade la frontera vertical: el chat presenta las
  opciones de una instancia real, el usuario elige agente, modelo variante y
  comando con argumentos, la ejecución termina técnicamente y el tablero muestra
  elegido, conocido y procedencia; una opción elegida que desaparece del listado
  produces el error explícito en el chat, sin ejecución nueva ni despacho
  duplicado, y el selector se reconsulta hasta reflejar el listado vigente.

## Límites

- El rechazo en pleno despacho (opción desaparecida entre la validación de la
  petición y la aplicación de la selección) está implementado como fail-closed,
  pero no hay prueba determinista: obligaría a una carrera real contra el
  registro del propio OpenCode. La opción desaparecida se prueba en la frontera
  reproducible: tras el borrado real del archivo de comando y la actualización
  del listado público.
- Una respuesta de error del envío del comando no acredita por sí sola ausencia
  de admisión. Sin evidencia suficiente se conserva `possibly-sent` y la
  exclusión, incluso ante un 404; no hay desbloqueo manual ni reenvío automático.
- Los agentes que la instancia marca como ocultos se muestran tal como los
  devuelve el listado público; la app no decide qué está expuesto.
- La comprobación de estabilidad puede tardar hasta 5 s la primera vez que se
  consultan las opciones de un estado frío del motor; después la vista conserva
  el listado hasta que se vuelve a consultar.
