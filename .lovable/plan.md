## Befund

Die Datenbank enthält den Nutzer `zennergilbert@gmail.com` korrekt als `super_admin` und als Mitglied der aktiven Gruppe `Admin`. Das Problem sitzt sehr wahrscheinlich im App-Code: Die globale Zugangssperre zeigt bei jedem Fehler aus `getMyAccessContext()` dieselbe Meldung wie bei fehlender Gruppe. Dadurch sieht ein Auth-/Server-Function-/RLS-Fehler für dich fälschlich wie „nicht in Gruppe“ aus.

## Plan

1. **Zugangsprüfung robuster machen**
   - `getMyAccessContext()` so ändern, dass Fehler beim Rollen-/Gruppen-Lesen nicht still zu `false/null` werden.
   - Wenn die DB sagt „Rolle vorhanden“, muss `isSuperAdmin` zuverlässig `true` zurückgeben.

2. **Fehlermeldung korrigieren**
   - In `AuthGate` echte technische Zugriffsfehler getrennt anzeigen statt „Waiting for admin approval“.
   - „Waiting for admin approval“ nur noch anzeigen, wenn der Server erfolgreich geantwortet hat und wirklich weder Admin-Rolle noch aktive Gruppe vorhanden ist.

3. **Admin-Route absichern und erreichbar machen**
   - `/admin` nutzt dieselbe geprüfte Access-Query und zeigt bei Admins direkt das Admin Panel.
   - Der Admin-Link unten rechts erscheint, sobald `isSuperAdmin` erfolgreich erkannt wurde.

4. **Validierung**
   - Mit der vorhandenen Browser-Session lokal prüfen, ob nach Login die App nicht mehr blockiert und `/admin` erreichbar ist.
   - Wenn ein Server-Function-Fehler auftaucht, die konkrete Fehlermeldung sichtbar machen statt sie als Gruppenproblem zu tarnen.