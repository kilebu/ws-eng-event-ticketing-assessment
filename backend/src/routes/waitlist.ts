import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/auth.js";

const router = Router();

// POST /api/events/:eventId/waitlist - Join event waitlist
router.post("/:eventId/waitlist", authenticate, async (req, res) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const eventId = req.params.eventId as string;
      const userId = req.user!.userId;

      const event = await tx.event.findUnique({
        where: { id: eventId },
      });

      if (!event) {
        throw new Error("EVENT_NOT_FOUND:Event not found");
      }

      if (event.status !== "PUBLISHED") {
        throw new Error("NOT_PUBLISHED:Event is not published");
      }

      const existingBooking = await tx.booking.findFirst({
        where: {
          userId,
          eventId,
          status: "CONFIRMED",
        },
      });

      if (existingBooking) {
        throw new Error("ALREADY_BOOKED:You already have a confirmed booking for this event");
      }

      const existingWaitlistEntry = await tx.waitlistEntry.findFirst({
        where: {
          userId,
          eventId,
          status: "WAITING",
        },
      });

      if (existingWaitlistEntry) {
        const position = await tx.waitlistEntry.count({
          where: {
            eventId,
            status: "WAITING",
            joinedAt: {
              lt: new Date(existingWaitlistEntry.joinedAt.getTime() + 1),
            },
          },
        });

        return {
          position,
          joinedAt: existingWaitlistEntry.joinedAt,
        };
      }

      const waitlistEntry = await tx.waitlistEntry.create({
        data: {
          userId,
          eventId,
          status: "WAITING",
        },
      });

      const position = await tx.waitlistEntry.count({
        where: {
          eventId,
          status: "WAITING",
          joinedAt: {
            lt: new Date(waitlistEntry.joinedAt.getTime() + 1),
          },
        },
      });

      return {
        position,
        joinedAt: waitlistEntry.joinedAt,
      };
    });

    res.status(201).json({
      success: true,
      position: result.position,
      joinedAt: result.joinedAt,
    });
  } catch (error: unknown) {
    const err = error as Error;
    console.error("Error joining waitlist:", err);

    if (err.message?.startsWith("EVENT_NOT_FOUND:")) {
      return res.status(404).json({
        success: false,
        error: "EVENT_NOT_FOUND",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("NOT_PUBLISHED:")) {
      return res.status(400).json({
        success: false,
        error: "NOT_PUBLISHED",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("ALREADY_BOOKED:")) {
      return res.status(409).json({
        success: false,
        error: "ALREADY_BOOKED",
        message: err.message.split(":")[1],
      });
    }

    res.status(500).json({
      success: false,
      error: "ERROR",
      message: "Failed to join waitlist",
    });
  }
});

// GET /api/events/:eventId/waitlist/position - Get current user's waitlist position
router.get("/:eventId/waitlist/position", authenticate, async (req, res) => {
  try {
    const eventId = req.params.eventId as string;
    const userId = req.user!.userId;

    const waitlistEntry = await prisma.waitlistEntry.findFirst({
      where: {
        userId,
        eventId,
        status: "WAITING",
      },
    });

    if (!waitlistEntry) {
      return res.json({
        position: null,
      });
    }

    const position = await prisma.waitlistEntry.count({
      where: {
        eventId,
        status: "WAITING",
        joinedAt: {
          lt: new Date(waitlistEntry.joinedAt.getTime() + 1),
        },
      },
    });

    res.json({
      position,
    });
  } catch (error) {
    console.error("Error fetching waitlist position:", error);
    res.status(500).json({
      success: false,
      error: "ERROR",
      message: "Failed to fetch waitlist position",
    });
  }
});

// DELETE /api/events/:eventId/waitlist - Leave waitlist
router.delete("/:eventId/waitlist", authenticate, async (req, res) => {
  try {
    await prisma.$transaction(async (tx) => {
      const eventId = req.params.eventId as string;
      const userId = req.user!.userId;

      const waitlistEntry = await tx.waitlistEntry.findFirst({
        where: {
          userId,
          eventId,
          status: "WAITING",
        },
      });

      if (!waitlistEntry) {
        throw new Error("NOT_FOUND:You are not currently on this waitlist");
      }

      await tx.waitlistEntry.update({
        where: { id: waitlistEntry.id },
        data: {
          status: "LEFT",
        },
      });
    });

    res.json({
      success: true,
    });
  } catch (error: unknown) {
    const err = error as Error;
    console.error("Error leaving waitlist:", err);

    if (err.message?.startsWith("NOT_FOUND:")) {
      return res.status(404).json({
        success: false,
        error: "NOT_FOUND",
        message: err.message.split(":")[1],
      });
    }

    res.status(500).json({
      success: false,
      error: "ERROR",
      message: "Failed to leave waitlist",
    });
  }
});

export default router;
