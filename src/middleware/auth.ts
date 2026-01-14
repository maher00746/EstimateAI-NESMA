import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { User, IUser } from "../modules/storage/userModel";

export interface AuthRequest extends Request {
  user?: IUser;
}

export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ message: "Authentication required. Please provide a valid token." });
      return;
    }

    const token = authHeader.substring(7); // Remove "Bearer " prefix

    if (!token) {
      res.status(401).json({ message: "Authentication required. Please provide a valid token." });
      return;
    }

    try {
      const decoded = jwt.verify(token, config.jwtSecret) as { userId: string };
      const user = await User.findById(decoded.userId).select("-password");

      if (!user) {
        res.status(401).json({ message: "User not found. Please login again." });
        return;
      }

      req.user = user;
      next();
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        res.status(401).json({ message: "Token expired. Please login again." });
        return;
      }
      if (error instanceof jwt.JsonWebTokenError) {
        res.status(401).json({ message: "Invalid token. Please login again." });
        return;
      }
      throw error;
    }
  } catch (error) {
    console.error("Authentication error:", error);
    res.status(500).json({ message: "Authentication failed. Please try again." });
  }
};

