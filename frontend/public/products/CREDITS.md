# Créditos de las fotos de producto

Fotos de ejemplo para las sesiones de visión (**S01** Rekognition `DetectLabels`, **S02**
`DetectModerationLabels`). Descargadas de Wikimedia Commons; ninguna se modificó.

## Por qué viven en `frontend/public/products/`

La `GUIA.md` de S01 sugiere subirlas a mano a `s3://<stack>-frontend/assets/`. **No hagas eso:**
`scripts/deploy-frontend.sh` termina en `aws s3 sync frontend/dist/ s3://<bucket>/ --delete`, y
`--delete` borra del bucket todo lo que no esté en `frontend/dist/`. Una foto subida a mano
desaparece en el siguiente deploy del frontend, sin ningún error visible: los productos vuelven a
mostrar la imagen rota.

Vite copia `public/` tal cual dentro de `dist/`, así que desde acá las fotos **son parte del deploy**
y `--delete` no las toca. Quedan disponibles en las dos formas que acepta el handler de S01:

- **HTTPS** — `https://<cloudfront>/products/<archivo>`: lo único que el navegador puede renderizar
  en un `<img>`. Es lo que guardamos en `imageUrl`.
- **s3://** — `s3://<stack>-frontend/products/<archivo>`: el patrón `S3Object` de producción, que
  Rekognition lee directo de S3 sin descargar nada. Cubierto por el `s3:GetObject` sobre
  `${AWS::StackName}-*` que declara el snippet de S01.

## Licencias

| Archivo | Original | Licencia | Autor | Crédito |
|---|---|---|---|---|
| `vestido-floral.jpg` | [Dress, evening, woman's (AM 8283-1).jpg](https://commons.wikimedia.org/wiki/File%3ADress%2C_evening%2C_woman%27s_%28AM_8283-1%29.jpg) | CC BY 4.0 | Unknown author Unknown author | API data Catalogue record Photo |
| `chaqueta-denim.jpg` | [Jean jacket.jpg](https://commons.wikimedia.org/wiki/File%3AJean_jacket.jpg) | CC0 | NikosLikomitros | Own work |
| `tenis-blancos.jpg` | [White Sneakers - Coach (49688016318).jpg](https://commons.wikimedia.org/wiki/File%3AWhite_Sneakers_-_Coach_%2849688016318%29.jpg) | CC BY 2.0 | Ajay Suresh from New York, NY, USA | White Sneakers - Coach |
| `bolso-tote.jpg` | [Reusable Bag 4.jpg](https://commons.wikimedia.org/wiki/File%3AReusable_Bag_4.jpg) | Public domain | Tanacollins | Own work |
