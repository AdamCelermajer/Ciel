Name: ciel
Version: @VERSION@
Release: 2
Summary: Personal multi-host coding session manager
License: LicenseRef-Proprietary
URL: https://localhost
Source0: ciel-%{version}.tar.gz
BuildArch: x86_64
AutoReqProv: no
Requires: glibc >= 2.28, libstdc++, systemd, xdg-utils, python3-gobject, gtk3, webkit2gtk4.1
%global debug_package %{nil}
%global __os_install_post %{nil}
%description
CIEL host service and native GTK window, with a bundled Node.js runtime.
%prep
%setup -q -n ciel-%{version}-linux-x64
%build
%install
mkdir -p %{buildroot}/opt/ciel %{buildroot}/usr/lib/systemd/user %{buildroot}/usr/share/applications %{buildroot}/etc/xdg/autostart
cp -a . %{buildroot}/opt/ciel/
install -m644 setup/ciel.service %{buildroot}/usr/lib/systemd/user/ciel.service
install -m644 setup/ciel.desktop %{buildroot}/usr/share/applications/io.ciel.Ciel.desktop
install -m644 setup/ciel-autostart.desktop %{buildroot}/etc/xdg/autostart/ciel.desktop
%files
/opt/ciel
/usr/lib/systemd/user/ciel.service
/usr/share/applications/io.ciel.Ciel.desktop
/etc/xdg/autostart/ciel.desktop
