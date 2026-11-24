# Filtrado estructural sin inventar otra proyección

`src/index.ts` decodifica el JSON completo de argumentos y entregables antes de
filtrar secretos: un literal escapado no debe eludir las exclusiones. El JSON
filtrado se serializa una vez; volver a filtrarlo como prosa puede destruir su
estructura. Las cabeceras Cookie/Set-Cookie se excluyen completas, incluidas sus
continuaciones plegadas: sus valores pueden contener espacios, comas y punto y
coma. Los fragmentos de texto transmitidos no se persisten como contenido porque
un secreto puede estar dividido entre chunks.

El texto libre puede cambiar por el filtrado, pero los discriminadores, roles,
fuentes, estados y claves deben seguir acreditando la proyección observada.
Si el filtrado cambia uno de esos elementos o el tipo de un escalar en una
proyección tipada, se omite la proyección como no reconocida en vez de afirmar
otro desenlace válido. Las conversiones de tipo posteriores se apoyan en esa
estructura validada y conservada, no en la preservación del texto original.

La captura del contexto se limita al texto autorizado: se excluyen razonamiento,
checkpoints cifrados, medios, metadata nativa/del proveedor y resultados
arbitrarios. Para entregables de herramientas, solo el argumento estructurado
vinculado por configuración local se resuelve contra el proyecto seleccionado.
No se extraen rutas de comandos, parches, prosa de resultados ni metadata
arbitraria. Es una frontera de autorización, no una heurística pendiente de ampliar.

Origen: comentarios de filtrado y entregables en `src/index.ts` y del secreto
fragmentado en `postman/mocks/synthetic-model/default.js`; véase la
[auditoría](../comment-audit.md).
