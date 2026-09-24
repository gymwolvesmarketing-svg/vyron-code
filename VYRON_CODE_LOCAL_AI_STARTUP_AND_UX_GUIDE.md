# Vyron Code — Tek Tıkla Yerel AI: Kullanım Rehberi

Bu rehber, Vyron Code Desktop'ı açan normal bir kullanıcı için yazılmıştır. Terminal komutu, ayar dosyası
veya anahtar girmeniz gerekmez.

## Uygulamayı açtığınızda ne olur?

1. **Vyron Code'u açın.** Ekranda "Vyron Code hazırlanıyor" görünür.
2. Uygulama yerel AI'yı sizin yerinize hazırlar. Sırayla şu mesajları görebilirsiniz:
   - "Yerel AI bağlantısı kontrol ediliyor…"
   - "Yerel AI motoru başlatılıyor…"
   - "Güvenli bağlantı hazırlanıyor…"
   - "Güvenli bağlantı doğrulanıyor…"
3. Hazır olduğunda üstte **"Yerel AI hazır"** yazar ve "Ne üzerinde çalışmak istiyorsun?" ekranı açılır.

Yerel AI daha önce başka bir yolla çalışıyorsa uygulama onu olduğu gibi kullanır; ikinci bir kopya
başlatmaz. İlk açılışta hazır olması yarım dakika kadar sürebilir.

## Bir görev göndermek

1. Kutuya görevinizi yazın (en fazla 4000 karakter).
2. **"Taslağı incele"** düğmesine basın (ya da Ctrl+Enter).
3. Gönderilecek metni tam olarak görürsünüz. Ekranda şunlar yazar: yalnız bu metin gönderilir; dosya,
   workspace, Git veya araç bağlamı gönderilmez; araçlar kapalıdır; kalıcı görev geçmişi oluşturulmaz.
4. Doğruysa **"İncelenen task'ı gönder"** düğmesine basın. Hiçbir şey kendiliğinden gönderilmez.
   Vazgeçmek için **"Geri dön"** (ya da Esc) yeterlidir; metin gönderilmemiş olur.
5. Yanıt "Yanıt" başlığı altında düz metin olarak görünür. Çok uzun yanıtlar kısaltılır ve bu belirtilir.
6. **"Yanıtı temizle"** taslağı ve yanıtı siler. Uygulamayı kapatıp açtığınızda da hiçbiri saklanmaz.

## "Yerel AI şu anda hazır değil" görürseniz

Ekranda kısa bir neden görünür:

| Görünen mesaj | Anlamı |
|---|---|
| Hermes başlatılamadı | Yerel AI motoru açılamadı. |
| Güvenli bağlantı doğrulanamadı | Güvenli bağlantı kurulamadı ya da doğrulanamadı. |
| Yerel model yanıt vermiyor | Bağlantı kuruldu ama model zamanında yanıt vermedi. |
| Yerel AI kullanılamıyor | Çalışırken yerel AI durdu ya da beklenmeyen bir sorun oluştu. |

Yapabilecekleriniz:

- **"Tekrar dene"**: Kurulumu bir kez daha dener. Uygulama kendi kendine sürekli yeniden denemez.
- **"Tanılama bilgilerini kopyala"**: Kısa, gizli bilgi içermeyen bir özeti panonuza kopyalar; destek
  isterken yapıştırabilirsiniz. Bu özette anahtar, adres, dosya yolu veya göndermiş olduğunuz metin yer almaz.

## Uygulamayı kapattığınızda ne olur?

Vyron Code, yalnızca **kendi başlattığı** yerel AI parçalarını kapatır. Siz onları başka bir yolla önceden
açmışsanız açık kalırlar.

## Gizlilik ve güvenlik özeti

- Arayüzde model seçici, sağlayıcı, API anahtarı, adres/port, araç, tarayıcı, dosya, Git veya workspace
  eki alanı yoktur.
- Gizli anahtar yalnızca uygulamanın arka planında okunur; ekrana, panoya ya da tanılama özetine girmez.
- Bağlantı yalnızca bu bilgisayar içindedir.
- Görev geçmişi, oturum listesi veya sohbet geçmişi tutulmaz.
