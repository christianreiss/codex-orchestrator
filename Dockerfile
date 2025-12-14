FROM composer:2 AS vendor
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --optimize-autoloader --no-interaction --prefer-dist

FROM php:8.2-apache
RUN apt-get update \
    && apt-get install -y --no-install-recommends default-mysql-client libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*
RUN docker-php-ext-install pdo_mysql pdo_sqlite
RUN a2enmod rewrite
ENV APACHE_DOCUMENT_ROOT=/var/www/html/public
RUN sed -ri -e 's!/var/www/html!${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/sites-available/000-default.conf /etc/apache2/apache2.conf
RUN set -eux; \
    printf '<Directory %s>\n    Require all granted\n    FallbackResource /index.php\n</Directory>\n' "$APACHE_DOCUMENT_ROOT" > /etc/apache2/conf-available/app-fallback.conf; \
    a2enconf app-fallback
RUN set -eux; \
    { \
        echo '# Admin UI: serve the shell directly; API calls route through the root front controller (/index.php).'; \
        echo "<Directory ${APACHE_DOCUMENT_ROOT}/admin>"; \
        echo '    DirectoryIndex index.php index.html'; \
        echo '    Options FollowSymLinks'; \
        echo '    AllowOverride None'; \
        echo '</Directory>'; \
        echo ''; \
        echo '<IfModule mod_rewrite.c>'; \
        echo '    RewriteEngine On'; \
        echo '    # Allow static assets through unchanged.'; \
        echo '    RewriteRule ^admin/assets/ - [L]'; \
        echo '    # Serve the admin shell from /admin or /admin/.'; \
        echo '    RewriteRule ^admin/?$ /admin/index.php [L]'; \
        echo '    # Everything else under /admin/* should hit the root front controller for JSON routes.'; \
        echo '    RewriteRule ^admin/.* /index.php [L]'; \
        echo '</IfModule>'; \
    } > /etc/apache2/conf-available/app-admin-mtls.conf; \
    a2enconf app-admin-mtls
RUN set -eux; \
    { \
        echo '# Ensure Authorization headers reach PHP (mod_php)'; \
        echo 'SetEnvIfNoCase Authorization "^(.*)$" HTTP_AUTHORIZATION=$1'; \
        echo '<Directory "/var/www/html">'; \
        echo '    RewriteEngine On'; \
        echo '    RewriteCond %{HTTP:Authorization} .'; \
        echo '    RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]'; \
        echo '</Directory>'; \
    } > /etc/apache2/conf-available/app-authz.conf; \
    a2enconf app-authz
WORKDIR /var/www/html
COPY . .
COPY --from=vendor /app/vendor ./vendor
RUN ./scripts/build-cdx.sh
RUN chown -R www-data:www-data storage
EXPOSE 80
CMD ["apache2-foreground"]
