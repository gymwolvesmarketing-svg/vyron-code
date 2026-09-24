# Vyron Code — Windows Kurulum ve Başlatma Rehberi

## Kullanıcılar için

1. **Vyron Code kurulum dosyasını çalıştırın** (`VyronCode-Setup-….exe`). Yönetici izni gerekmez; uygulama
   yalnızca sizin kullanıcı hesabınıza kurulur. İsterseniz kurulum klasörünü değiştirebilirsiniz.
2. **Vyron Code'u açın**: Başlat Menüsü'nden ya da masaüstündeki "Vyron Code" kısayolundan.
3. **"Yerel AI hazır" yazısını bekleyin.** Önce "Vyron Code hazırlanıyor" görünür; yerel AI sizin yerinize
   hazırlanır. İlk açılışta yarım dakika kadar sürebilir.
4. **Görevinizi yazın.**
5. Gönder okuna ya da **Ctrl+Enter**'a basın; ara bir inceleme adımı yoktur.
6. Yanıt aynı ekranda görünür. **"Yeni görev"** ile devam edin.
7. **"Yerel AI şu anda hazır değil"** görürseniz **"Tekrar dene"** düğmesine basın. Sorun sürerse
   "Tanılama bilgilerini kopyala" ile kısa, gizli bilgi içermeyen bir özet alıp destekle paylaşabilirsiniz.

Uygulamayı kapattığınızda yalnızca Vyron Code'un kendi başlattığı yerel AI parçaları kapanır. Açık bir
terminal penceresi gerekmez. Ayrıntılı kullanım için `VYRON_CODE_LOCAL_AI_STARTUP_AND_UX_GUIDE.md` dosyasına bakın.

> Kurulum dosyası dijital olarak imzalı değildir; Windows ilk açılışta "bilinmeyen yayıncı" uyarısı
> gösterebilir.

## Geliştiriciler için

```text
npm run electron:build     # Electron main/preload/renderer çıktısını derler (dist-electron/)
npm run electron:run       # Derleyip uygulamayı üretim benzeri çalıştırır (ayrı sunucu gerekmez)
npm run electron:package   # Açılmış Windows uygulama klasörünü üretir (release/win-unpacked/VyronCode.exe)
npm run electron:dist      # NSIS kurulum dosyasını üretir (release/VyronCode-Setup-<sürüm>.exe)
```

- Paketleme electron-builder ile yapılır (`electron-builder.yml`). Hiçbir şey yayımlanmaz, yüklenmez
  veya imzalanmaz. Çıktılar `release/` altındadır ve Git tarafından yok sayılır.
- Masaüstü arayüzü, pencerede `loadFile` ile yüklenen yerel statik renderer'dır. Bu yüzden pakete Next.js
  sunucusu, `node_modules` veya geliştirme sunucusu konmaz ve çalışma zamanında `npm`/`npx` gerekmez.
- Pakete yalnızca derlenmiş `dist-electron/` ve `scripts/hermes-auth-proxy.mjs` girer. Auth proxy betiği,
  ayrı bir Node süreciyle çalıştırıldığı için `app.asar.unpacked` altında açılmış olarak taşınır.
- Mevcut `npm run build` (Next) ve `npm run build:electron` komutları aynen çalışır.
