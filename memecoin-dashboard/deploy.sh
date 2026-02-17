#!/bin/bash
# Install nginx and PHP-FPM
sudo apt-get update
sudo apt-get install -y nginx php-fpm

# Create directory and copy files
sudo mkdir -p /var/www/memecoin-dashboard
sudo cp index.html style.css app.js config.json api.php /var/www/memecoin-dashboard/
sudo chown -R www-data:www-data /var/www/memecoin-dashboard
sudo chmod -R 755 /var/www/memecoin-dashboard
sudo chmod 664 /var/www/memecoin-dashboard/config.json

# Copy nginx config
sudo cp memecoin-dashboard.conf /etc/nginx/sites-available/
sudo ln -sf /etc/nginx/sites-available/memecoin-dashboard.conf /etc/nginx/sites-enabled/

# Test and restart nginx
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl restart php8.1-fpm 2>/dev/null || true

echo "Deployment complete! Access at http://YOUR_DROPLET_IP:8080"
