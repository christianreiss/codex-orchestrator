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
    printf '<Directory %s>\n    Require all granted\n    FallbackResource /index.php\n</Directory>\n' "$APACHE_DOCUMENT_ROOT" > /etc/apache2/conf-available/app-fallback.conf
RUN set -eux; \
    cat > /etc/apache2/conf-available/app-admin-mtls.conf <<'EOF' && a2enconf app-fallback app-admin-mtls
<Directory ${APACHE_DOCUMENT_ROOT}/admin>
    DirectoryIndex index.php index.html
    Require expr "%{HTTP:X-MTLS-FINGERPRINT} =~ m#^[A-Fa-f0-9]{64}$#"
</Directory>
EOF
RUN set -eux; \
    cat > /etc/apache2/conf-available/app-authz.conf <<'EOF' && a2enconf app-authz
# Ensure Authorization headers reach PHP (mod_php)
SetEnvIfNoCase Authorization "^(.*)$" HTTP_AUTHORIZATION=$1
<Directory "/var/www/html">
    RewriteEngine On
    RewriteCond %{HTTP:Authorization} .
    RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
</Directory>
EOF
WORKDIR /var/www/html
COPY . .
COPY --from=vendor /app/vendor ./vendor
RUN ./scripts/build-cdx.sh
RUN chown -R www-data:www-data storage
EXPOSE 80
CMD ["apache2-foreground"]
