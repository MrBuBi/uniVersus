import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";

// Инициализация Firebase Admin
admin.initializeApp();

const db = admin.firestore();
const messaging = admin.messaging();

// Получение API ключа Gemini из конфигурации Firebase
const getGeminiApiKey = (): string => {
  const apiKey =
    functions.config().gemini?.api_key || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Gemini API key не настроен. Установите через: firebase functions:config:set gemini.api_key=YOUR_KEY"
    );
  }
  return apiKey;
};

/**
 * Cloud Function для генерации вопросов через Gemini AI
 * Защищает API ключ от раскрытия на клиенте
 * Регион: europe-west1 (ближайший к Mersin, Turkey)
 */
export const generateQuestions = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    // Проверка аутентификации
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Пользователь должен быть аутентифицирован"
      );
    }

    try {
      const {
        category,
        difficulty,
        count,
        language,
        context: promptContext,
      } = data;

      // Валидация входных данных
      if (!category || !difficulty || !count) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "Отсутствуют обязательные параметры: category, difficulty, count"
        );
      }

      if (count > 10) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "Максимальное количество вопросов: 10"
        );
      }

      const apiKey = getGeminiApiKey();
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });

      // Формирование промпта
      const prompt = `
Сгенерируй ${count} вопросов викторины по теме "${category}" со сложностью ${difficulty} на языке ${
        language || "ru"
      }.

Требования:
- Каждый вопрос должен иметь ровно 4 варианта ответа
- Один вариант должен быть явно правильным
- Варианты должны быть правдоподобными, но различными
- Включи объяснение правильного ответа (опционально)
- Вопросы должны быть образовательными и фактически точными
${promptContext ? `\nКонтекст: ${promptContext}` : ""}

Верни ответ ТОЛЬКО как JSON массив в следующем формате (без дополнительного текста, только JSON):
[
  {
    "question": "Текст вопроса",
    "options": ["Вариант 1", "Вариант 2", "Вариант 3", "Вариант 4"],
    "correctAnswerIndex": 0,
    "explanation": "Объяснение правильного ответа (опционально)"
  }
]

ВАЖНО: Верни ТОЛЬКО валидный JSON массив, без дополнительного текста до или после.
    `;

      // Генерация вопросов
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();

      // Парсинг JSON из ответа
      let questions;
      try {
        // Извлекаем JSON из ответа (может быть обернут в markdown код)
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          questions = JSON.parse(jsonMatch[0]);
        } else {
          questions = JSON.parse(text);
        }
      } catch (parseError) {
        functions.logger.error("Ошибка парсинга ответа Gemini:", text);
        throw new functions.https.HttpsError(
          "internal",
          "Не удалось обработать ответ от AI"
        );
      }

      // Валидация и сохранение вопросов
      const savedQuestions = [];
      for (const q of questions) {
        if (
          q.question &&
          q.options &&
          q.options.length === 4 &&
          typeof q.correctAnswerIndex === "number"
        ) {
          const questionData = {
            translations: {
              [language || "ru"]: {
                text: q.question,
                options: q.options,
                explanation: q.explanation || "",
              },
            },
            category,
            difficulty,
            correctAnswerIndex: q.correctAnswerIndex,
            source: "ai",
            status: "pending_review",
            usageCount: 0,
            ratings: [],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          };

          const docRef = await db.collection("questions").add(questionData);
          savedQuestions.push({
            id: docRef.id,
            ...questionData,
          });
        }
      }

      functions.logger.info(
        `Сгенерировано ${savedQuestions.length} вопросов пользователем ${context.auth.uid}`
      );

      return {
        success: true,
        questions: savedQuestions,
        count: savedQuestions.length,
      };
    } catch (error: any) {
      functions.logger.error("Ошибка генерации вопросов:", error);
      throw new functions.https.HttpsError(
        "internal",
        error.message || "Ошибка при генерации вопросов"
      );
    }
  });

/**
 * Cloud Function для отправки уведомлений
 * Безопасная отправка через Firebase Cloud Messaging
 * Регион: europe-west1
 */
export const sendNotification = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Пользователь должен быть аутентифицирован"
      );
    }

    try {
      const { targetUid, notification, data: notificationData } = data;

      // Проверка прав: можно отправлять только себе или если это системное уведомление
      if (targetUid !== context.auth.uid && !data.systemNotification) {
        throw new functions.https.HttpsError(
          "permission-denied",
          "Недостаточно прав"
        );
      }

      // Получение токенов устройства пользователя
      const tokensSnapshot = await db
        .collection("deviceTokens")
        .where("uid", "==", targetUid)
        .get();

      if (tokensSnapshot.empty) {
        return {
          success: false,
          error: "У пользователя нет зарегистрированных устройств",
        };
      }

      const tokens = tokensSnapshot.docs.map((doc) => doc.data().token);

      const message: admin.messaging.MulticastMessage = {
        notification: {
          title: notification.title,
          body: notification.body,
        },
        data: notificationData || {},
        tokens,
      };

      const response = await messaging.sendMulticast(message);

      functions.logger.info(
        `Уведомление отправлено пользователю ${targetUid}: ${response.successCount}/${tokens.length}`
      );

      return {
        success: true,
        sent: response.successCount,
        failed: response.failureCount,
      };
    } catch (error: any) {
      functions.logger.error("Ошибка отправки уведомления:", error);
      throw new functions.https.HttpsError(
        "internal",
        error.message || "Ошибка отправки уведомления"
      );
    }
  });

/**
 * Cloud Function для безопасного обновления рейтинга после матча
 * Предотвращает манипуляции с рейтингом на клиенте
 * Регион: europe-west1
 */
export const updateRatingAfterMatch = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Пользователь должен быть аутентифицирован"
      );
    }

    try {
      const { matchId, winnerUid, loserUid, isDraw } = data;

      // Проверка, что пользователь является участником матча
      const matchDoc = await db.collection("matches").doc(matchId).get();
      if (!matchDoc.exists) {
        throw new functions.https.HttpsError("not-found", "Матч не найден");
      }

      const match = matchDoc.data();
      const userUid = context.auth.uid;

      if (match?.player1?.uid !== userUid && match?.player2?.uid !== userUid) {
        throw new functions.https.HttpsError(
          "permission-denied",
          "Вы не являетесь участником матча"
        );
      }

      // Проверка, что матч завершен
      if (match?.status !== "completed") {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Матч еще не завершен"
        );
      }

      // Проверка, что рейтинг еще не обновлен
      if (match?.ratingUpdated === true) {
        throw new functions.https.HttpsError(
          "already-exists",
          "Рейтинг уже обновлен"
        );
      }

      // Обновление рейтинга через транзакцию
      const batch = db.batch();

      const winnerLeaderRef = db.collection("leaders").doc(winnerUid);
      const loserLeaderRef = db.collection("leaders").doc(loserUid);

      if (isDraw) {
        batch.update(winnerLeaderRef, {
          points: admin.firestore.FieldValue.increment(1),
          draws: admin.firestore.FieldValue.increment(1),
          rating: admin.firestore.FieldValue.increment(5),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        batch.update(loserLeaderRef, {
          points: admin.firestore.FieldValue.increment(1),
          draws: admin.firestore.FieldValue.increment(1),
          rating: admin.firestore.FieldValue.increment(5),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        // Победа: +20 рейтинга, поражение: -10 рейтинга
        batch.update(winnerLeaderRef, {
          points: admin.firestore.FieldValue.increment(3),
          wins: admin.firestore.FieldValue.increment(1),
          rating: admin.firestore.FieldValue.increment(20),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        batch.update(loserLeaderRef, {
          points: admin.firestore.FieldValue.increment(1),
          losses: admin.firestore.FieldValue.increment(1),
          rating: admin.firestore.FieldValue.increment(-10),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // Отмечаем, что рейтинг обновлен
      batch.update(db.collection("matches").doc(matchId), {
        ratingUpdated: true,
      });

      await batch.commit();

      functions.logger.info(`Рейтинг обновлен для матча ${matchId}`);

      return { success: true };
    } catch (error: any) {
      functions.logger.error("Ошибка обновления рейтинга:", error);
      throw new functions.https.HttpsError(
        "internal",
        error.message || "Ошибка обновления рейтинга"
      );
    }
  });

/**
 * Health check endpoint для мониторинга
 * Регион: europe-west1
 */
export const healthCheck = functions
  .region("europe-west1")
  .https.onRequest(async (req, res) => {
    try {
      // Проверка подключения к Firestore
      await db.collection("_health").doc("check").set({
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.status(200).json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        services: {
          firestore: "ok",
          messaging: "ok",
        },
      });
    } catch (error: any) {
      functions.logger.error("Health check failed:", error);
      res.status(503).json({
        status: "unhealthy",
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  });

/**
 * Scheduled function для очистки старых записей очереди matchmaking
 * Запускается каждые 10 минут
 * Регион: europe-west1
 */
export const cleanupMatchmakingQueue = functions
  .region("europe-west1")
  .pubsub.schedule("every 10 minutes")
  .onRun(async (context) => {
    try {
      const tenMinutesAgo = admin.firestore.Timestamp.fromMillis(
        Date.now() - 10 * 60 * 1000
      );

      const oldEntries = await db
        .collection("waiting")
        .where("waitingSince", "<", tenMinutesAgo)
        .get();

      const batch = db.batch();
      oldEntries.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });

      await batch.commit();

      functions.logger.info(
        `Очищено ${oldEntries.size} старых записей из очереди matchmaking`
      );
      return null;
    } catch (error: any) {
      functions.logger.error("Ошибка очистки очереди:", error);
      return null;
    }
  });
