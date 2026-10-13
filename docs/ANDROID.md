# TRUE on an Android phone (debug APK)

The phone runs the app; the servers stay on the laptop. Phone and laptop must be on the **same Wi-Fi**.
Nothing here has been tested on a real phone yet.

## 1. Laptop
1. `npm run dev` (starts everything). Leave it running.
2. Find the laptop's IP: open PowerShell, run `ipconfig`, read **IPv4 Address** under "Wireless LAN adapter Wi-Fi" (for example `192.168.1.20`).
3. Windows Firewall: the first time, Windows asks to allow **Node.js** on networks. Tick **Private** and allow. If you missed it: Windows Security > Firewall > Allow an app > Node.js JavaScript Runtime > tick Private. The Wi-Fi itself must be set to "Private network" in Windows settings.
4. Quick check from the phone's browser: open `http://<laptop-ip>:4001/v1/status-list`. If you see a line of JSON, the phone can reach the laptop.

## 2. Build the APK (only after code changes)
```
npm run build -w @true/app
npm run check:offline
cd apps/app && npx cap sync android
cd android && set "JAVA_HOME=C:\Program Files\Java\jdk-21.0.12" && gradlew.bat assembleDebug
```
APK: `apps/app/android/app/build/outputs/apk/debug/app-debug.apk`. Use JDK 21 as shown: Android Studio's bundled JDK 25 is too new for this Gradle version.

## 3. Install on the phone (Samsung, Android 14)
1. Copy `app-debug.apk` to the phone (USB cable, or send it to yourself) and tap it in **My Files**.
2. "Install unknown apps": allow it for the app you opened the file with (My Files).
3. **Auto Blocker** (Settings > Security and privacy > Auto Blocker): if it blocks the install, turn it off, install, turn it back on.
4. **Play Protect** may warn that the app is unknown: choose "Install anyway" (it is a debug build signed with a local test key).
5. Second phone: same steps. Each phone has its own wallet.

## 4. First start
1. On the first screen, type the laptop address in **Server address**: `http://192.168.1.20` (your IP, **no port**).
2. Tap **Save and test connection**. Both lines must say "reachable".
3. Log in with a demo account (emails in the README; passwords in the laptop's `.env`).
4. Scan tab > **Scan QR with the camera**: allow the camera when asked.

## Troubleshooting
- **Not reachable:** wrong IP (it changes when the laptop reconnects), phone on mobile data or another Wi-Fi, firewall not allowed for Private networks, or `npm run dev` not running. Some college/guest Wi-Fi blocks devices from talking to each other: use a phone hotspot and connect the laptop to it.
- **Camera refused:** Settings > Apps > TRUE > Permissions > Camera > Allow. Or paste the link in the Scan tab.
- **QR from the laptop's Ops console does not open on the phone:** those QR codes contain `localhost`. Use a register's QR made on a phone (Registers tab).
- **Logged out or empty wallet after reinstall:** uninstalling deletes the app's storage, including the wallet key. Issue the IDs again.
- **Ops console (port 5175), kill/restart and the chain node** are reachable only on the laptop itself, on purpose.
