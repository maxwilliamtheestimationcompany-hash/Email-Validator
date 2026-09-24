# VPS deployment

This pack defaults to local-only access on 127.0.0.1:3093. Use START-WINDOWS.bat for normal desktop use.

The optional legacy-named INSTALL-VPS-FREE.sh installs Node and Nginx and preserves .env. The name does not mean Validect usage is free. Configure a Validect RapidAPI subscription and RAPIDAPI_KEY. Run `sudo bash INSTALL-VPS-FREE.sh your-domain.example` only on a server you administer. This installer changes Nginx configuration.

Before exposing this application, put authentication and HTTPS in front of Nginx. There is no built-in user login; anyone with access can consume API credits and access jobs. Keep the backend bound to localhost. Keep .env and data/jobs private and backed up. Never host the entire project folder as public static files.
