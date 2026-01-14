import { Router, Request, Response, NextFunction } from "express";
import jwt, { type Secret, type SignOptions } from "jsonwebtoken";
import { config } from "../config";
import { User } from "../modules/storage/userModel";
import { authenticate, AuthRequest } from "../middleware/auth";

const router = Router();

// Register new user
router.post("/register", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, email, password } = req.body;

    // Validation
    if (!username || !email || !password) {
      return res.status(400).json({
        message: "Username, email, and password are required"
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        message: "Password must be at least 6 characters long"
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ username }, { email }],
    });

    if (existingUser) {
      return res.status(409).json({
        message: "User with this username or email already exists"
      });
    }

    // Create new user
    const user = new User({
      username,
      email,
      password,
    });

    await user.save();

    // Generate JWT token
    const tokenOptions: SignOptions = {
      expiresIn: config.jwtExpiresIn as SignOptions["expiresIn"],
    };

    const token = jwt.sign({ userId: user.id }, config.jwtSecret as Secret, tokenOptions);

    res.status(201).json({
      message: "User registered successfully",
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Login
router.post("/login", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password } = req.body;

    // Validation
    if (!username || !password) {
      return res.status(400).json({
        message: "Username and password are required"
      });
    }

    // Find user by username or email
    const user = await User.findOne({
      $or: [{ username }, { email: username }],
    });

    if (!user) {
      return res.status(401).json({
        message: "Invalid username or password"
      });
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
      return res.status(401).json({
        message: "Invalid username or password"
      });
    }

    // Generate JWT token
    const tokenOptions: SignOptions = {
      expiresIn: config.jwtExpiresIn as SignOptions["expiresIn"],
    };

    const token = jwt.sign({ userId: user.id }, config.jwtSecret as Secret, tokenOptions);

    res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Verify token and get current user
router.get("/verify", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "User not found" });
    }

    res.status(200).json({
      user: {
        id: req.user._id,
        username: req.user.username,
        email: req.user.email,
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to verify token" });
  }
});

// Logout (client-side token removal, but we can track it if needed)
router.post("/logout", authenticate, async (req: AuthRequest, res: Response) => {
  // Since we're using JWT, logout is handled client-side by removing the token
  // This endpoint can be used for logging purposes or future token blacklisting
  res.status(200).json({ message: "Logout successful" });
});

export default router;

